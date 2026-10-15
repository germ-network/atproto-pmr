/**
 * The owner's summary: their graph and their own block list, plus the full
 * proof CAR of every watched record of every DID in the graph, so a device holds what it needs without
 * querying record by record. A read names the summary state the client
 * already holds by its token, and gets only what changed since; an unknown
 * token gets the whole summary. The indices behind recent tokens are private
 * state on the owner's registration.
 */

import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import {
    encodeGraphReadResponse,
    graphFromCose,
    graphToCose,
    type GraphProjectionStore,
} from "./device-read.js"
import type { BlockEdgeStore } from "./block-edges.js"
import { OWN_BLOCK_KEYS, type GraphReadResponse, type OwnBlock } from "./read-api.js"
import { readRecordFromCar } from "./repo-proof.js"
import { servableUnderRotation, type ReadSigningKey, type ReadSigningKeys } from "./read-signing-key.js"
import { SNAPSHOT_MAX_AGE_MS, type RecordSnapshotStore } from "./snapshot-read.js"
import { DECLARATION_COLLECTION_NSID } from "./declaration.js"
import type { WatchedRecord } from "./watched.js"

export interface SummaryRecordRef {
    did: string
    collection: string
    rkey: string
}

/** One record's state in a summary, without its CAR. */
export interface SummaryIndexEntry extends SummaryRecordRef {
    cid: string
    /**
     * The key ingest verified it against. Part of the diff: a CAR re-signed
     * under a rotated key keeps its CID but must still reach the device.
     */
    verifiedWith: string
}

/** Enough of a summary to diff against: the graph, the owner's blocks and each record's state. */
export interface SummaryIndex {
    graph: GraphReadResponse
    /**
     * The owner's own `app.bsky.graph.block` records, by rkey (not the
     * relay's blocked senders); they never appear in the graph or on a public
     * route.
     */
    ownBlocks: OwnBlock[]
    records: SummaryIndexEntry[]
    /** Delivered by a page that left more: a client holding it is mid-sync. */
    more?: boolean
}

export interface SummaryRecord extends SummaryIndexEntry {
    /** The held proof CAR, byte for byte. */
    car: Uint8Array
}

export interface SummaryDelta {
    /** Name this on the next read to get only what changes after it. */
    token: string
    /**
     * The named token was missing or no longer held, so this is the whole
     * summary and `removed` is empty: the client replaces everything it
     * holds, since nothing can name what it held that is now gone.
     */
    full: boolean
    /** Null when the graph is unchanged since the named state. */
    graph: GraphReadResponse | null
    /**
     * The owner's whole block list, null when it is unchanged since the named
     * state. A list is sent whole, since a removal names no block by itself.
     */
    ownBlocks: OwnBlock[] | null
    /** Records added, or whose CID or verifying key changed. */
    records: SummaryRecord[]
    /** Records in the named state no longer in the summary, including any no longer verified. */
    removed: SummaryRecordRef[]
    /**
     * More changes remain than one response carries: read again at once,
     * naming this response's token. A `full` response that sets it is the
     * first page of a replacement; the pages after it are ordinary deltas.
     */
    more: boolean
    /**
     * The owner's graph has more contacts than a summary covers, so the
     * records of the lowest-priority contacts are left out (owner, then
     * mutuals, following, followers).
     */
    truncated: boolean
}

/** How many served summary states a registration can name back. */
export const SUMMARY_TOKENS_KEPT = 4

/**
 * Records a summary indexes. Contacts are capped at this over the watched
 * count, so adding a watched collection cannot push an index build past an
 * invocation's store reads (about a thousand; bulk reads of a hundred keys
 * count as one). Each bulk metadata read also moves the CARs it discards,
 * about 3 KB apiece.
 */
export const SUMMARY_MAX_RECORDS = 6_000

/**
 * Records whose CARs one response carries. Each is a record read and a
 * confirmation read (two KV operations), on top of a full index build of
 * about two hundred bulk reads at the contact cap, all within one
 * invocation's thousand; changes beyond this wait for the next page.
 */
export const SUMMARY_PAGE_RECORDS = 300

/** A held, ingest-verified record's index entry, read without its CAR. */
export interface SummaryHeldEntry extends SummaryIndexEntry {
    freshAtMs: number
}

export interface SummaryIndexReader {
    /**
     * Each ref's entry, in order: null where nothing is held or ingest did
     * not verify it. Never reads a CAR, so a whole index costs a few bulk reads.
     */
    entries(refs: readonly SummaryRecordRef[]): Promise<(SummaryHeldEntry | null)[]>
}

export interface SummaryPageDeps {
    projections: GraphProjectionStore
    /**
     * The owner's own blocks. Throws when they cannot be read, and returns
     * null when the owner's graph is not served; neither is ever an empty list.
     */
    blocks: Pick<BlockEdgeStore, "ownBlocks">
    index: SummaryIndexReader
    /** Read once per delivered record, for its CAR. */
    records: RecordSnapshotStore
    signingKeys: ReadSigningKeys
    /** Every singleton this PMR snapshots, the declaration included. */
    watched: WatchedRecord[]
    /**
     * Told of a held declaration past `SNAPSHOT_MAX_AGE_MS`: the monitor is
     * over a day behind, an operational alarm. Never a re-check request.
     */
    onLapse: (did: string) => void
    nowMs: () => number
}

/** The owner's blocks could not be read, so no summary can be built without losing them. */
export class SummaryOwnBlocksError extends Error {
    constructor(cause: unknown) {
        super("the owner's blocks could not be read", { cause })
        this.name = "SummaryOwnBlocksError"
    }
}

/**
 * The DIDs a summary covers, the owner first, then mutuals, following and
 * followers, each by DID; at most `maxContacts` (`SUMMARY_MAX_RECORDS` over
 * the watched count). `truncated` when any were left out.
 */
export function summaryContacts(
    owner: string,
    graph: GraphReadResponse,
    maxContacts: number
): { dids: string[]; truncated: boolean } {
    const mutuals = graph.following.filter((e) => e.mutual).map((e) => e.did)
    const following = graph.following.map((e) => e.did)
    const followers = graph.followers.map((e) => e.did)
    const seen = new Set<string>([owner])
    const dids = [owner]
    for (const group of [mutuals, following, followers]) {
        for (const did of [...new Set(group)].sort(compareStrings)) {
            if (seen.has(did)) continue
            seen.add(did)
            dids.push(did)
        }
    }
    return { dids: dids.slice(0, maxContacts), truncated: dids.length > maxContacts }
}

/**
 * The summary's index as held now: the owner's projection and the entry of
 * every watched record of each covered contact that is held, verified at
 * ingest and servable under rotation. Reads no CAR. Null when the owner has
 * no projection yet or their graph is not served for blocks. Throws
 * `SummaryOwnBlocksError` when the blocks cannot be read.
 */
export async function buildSummaryIndex(
    did: string,
    deps: SummaryPageDeps
): Promise<{ index: SummaryIndex; truncated: boolean } | null> {
    const graph = await deps.projections.get(did)
    if (!graph) return null
    let blocks
    try {
        blocks = await deps.blocks.ownBlocks(did)
    } catch (error) {
        throw new SummaryOwnBlocksError(error)
    }
    if (blocks === null) return null
    const ownBlocks = blocks
        .map((b) => ({ did: b.subject, rkey: b.rkey }))
        .sort((a, b) => compareStrings(a.rkey, b.rkey) || compareStrings(a.did, b.did))
    const maxContacts = Math.floor(SUMMARY_MAX_RECORDS / Math.max(1, deps.watched.length))
    const { dids, truncated } = summaryContacts(did, graph, maxContacts)
    const refs = dids.flatMap((d) =>
        deps.watched.map((w) => ({ did: d, collection: w.collection, rkey: w.rkey }))
    )
    const held = await deps.index.entries(refs)
    const heldDids = [...new Set(held.flatMap((e) => (e === null ? [] : [e.did])))]
    const keys = heldDids.length === 0 ? new Map() : await deps.signingKeys.keysFor(heldDids)
    const now = deps.nowMs()
    const lapsed = new Set<string>()
    const records: SummaryIndexEntry[] = []
    for (const entry of held) {
        if (entry === null) continue
        const key = keys.get(entry.did) ?? { kind: "unknown" as const }
        if (!servableUnderRotation(entry.verifiedWith, key)) continue
        if (
            entry.collection === DECLARATION_COLLECTION_NSID &&
            entry.rkey === "self" &&
            !(now - entry.freshAtMs <= SNAPSHOT_MAX_AGE_MS)
        ) {
            lapsed.add(entry.did)
        }
        const { freshAtMs: _freshAtMs, ...indexed } = entry
        records.push(indexed)
    }
    for (const lapse of lapsed) deps.onLapse(lapse)
    records.sort(compareRefs)
    return { index: { graph, ownBlocks, records }, truncated }
}

/**
 * One page from `base` toward `current`: the graph if it changed, at most
 * `limit` changed records with their CARs, and every removal. Each
 * delivered record takes the entry of its own CAR read, so served bytes
 * match the index; one gone or no longer servable by then is reported
 * removed. Changed records go in `(did, collection, rkey)` order, the
 * owner's first. `delivered` is the index the client holds after this page,
 * which is what the page's token must name.
 */
export async function readSummaryPage(
    base: SummaryIndex | null,
    current: SummaryIndex,
    deps: Pick<SummaryPageDeps, "records" | "signingKeys">,
    limit: number
): Promise<{
    delivered: SummaryIndex
    page: Omit<SummaryDelta, "token" | "truncated">
}> {
    const diff = diffSummaryIndex(base, current)
    const owner = current.graph.did
    const ordered = [...diff.changed].sort(
        (a, b) =>
            Number(b.did === owner) - Number(a.did === owner) || compareRefs(a, b)
    )
    const batch = ordered.slice(0, Math.max(1, limit))
    const more = ordered.length > batch.length

    const keys =
        batch.length === 0
            ? new Map<string, ReadSigningKey>()
            : await deps.signingKeys.keysFor([...new Set(batch.map((e) => e.did))])
    const reads = await Promise.all(
        batch.map((entry) =>
            readSummaryRecord(entry, deps.records, keys.get(entry.did) ?? { kind: "unknown" })
        )
    )
    const records = reads.filter((r): r is SummaryRecord => r !== null)
    const dropped = batch
        .filter((_, i) => reads[i] === null)
        .map(({ did, collection, rkey }) => ({ did, collection, rkey }))
    const kept = new Map(
        (diff.full ? [] : base!.records).map((e) => [refKey(e), e] as const)
    )
    // A drop is a removal only for a record the client holds.
    const removed = [...diff.removed, ...dropped.filter((r) => kept.has(refKey(r)))]
    for (const gone of removed) kept.delete(refKey(gone))
    for (const { car: _car, ...entry } of records) kept.set(refKey(entry), entry)
    const delivered: SummaryIndex = {
        graph: current.graph,
        ownBlocks: current.ownBlocks,
        records: [...kept.values()].sort(compareRefs),
        ...(more ? { more: true } : {}),
    }
    return {
        delivered,
        page: {
            full: diff.full,
            graph: diff.graphChanged ? current.graph : null,
            ownBlocks: diff.blocksChanged ? current.ownBlocks : null,
            records,
            removed,
            more,
        },
    }
}

/**
 * The record as its own store read holds it: its entry is taken from that
 * read, so the CAR served matches the index stored under the token. Null when
 * nothing verified is held, it fails to parse, or it is no longer servable
 * under the DID's current key. The parse only runs for an entry stored
 * without its verified `rev` and `cid`.
 */
async function readSummaryRecord(
    ref: SummaryRecordRef,
    store: RecordSnapshotStore,
    key: ReadSigningKey
): Promise<SummaryRecord | null> {
    const snapshot = await store.get(ref.did, ref.collection, ref.rkey)
    if (!snapshot || snapshot.verifiedWith === null) return null
    if (!servableUnderRotation(snapshot.verifiedWith, key)) return null
    let cid = snapshot.rev !== null ? snapshot.cid : null
    if (cid === null) {
        let parsed
        try {
            parsed = readRecordFromCar(snapshot.car, ref.collection, ref.rkey)
        } catch {
            return null
        }
        if (!parsed || parsed.did !== ref.did) return null
        cid = parsed.cid
    }
    return {
        did: ref.did,
        collection: ref.collection,
        rkey: ref.rkey,
        cid,
        verifiedWith: snapshot.verifiedWith,
        car: snapshot.car,
    }
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

function compareRefs(a: SummaryRecordRef, b: SummaryRecordRef): number {
    return (
        compareStrings(a.did, b.did) ||
        compareStrings(a.collection, b.collection) ||
        compareStrings(a.rkey, b.rkey)
    )
}

/** Identifies a record across summaries. */
export const refKey = (r: SummaryRecordRef) => JSON.stringify([r.did, r.collection, r.rkey])

/**
 * What changed from `base` to `current`. With no `base`, everything changed
 * and `full` is set. Entries are compared on `(cid, verifiedWith)`.
 */
export function diffSummaryIndex(
    base: SummaryIndex | null,
    current: SummaryIndex
): {
    full: boolean
    graphChanged: boolean
    blocksChanged: boolean
    changed: SummaryIndexEntry[]
    removed: SummaryRecordRef[]
} {
    if (!base) {
        return { full: true, graphChanged: true, blocksChanged: true, changed: current.records, removed: [] }
    }
    const before = new Map(base.records.map((e) => [refKey(e), e]))
    const after = new Set(current.records.map(refKey))
    return {
        full: false,
        graphChanged: !equalBytes(
            encodeGraphReadResponse(base.graph),
            encodeGraphReadResponse(current.graph)
        ),
        blocksChanged:
            base.ownBlocks.length !== current.ownBlocks.length ||
            base.ownBlocks.some(
                (b, i) => b.did !== current.ownBlocks[i]!.did || b.rkey !== current.ownBlocks[i]!.rkey
            ),
        changed: current.records.filter((e) => {
            const prior = before.get(refKey(e))
            return !prior || prior.cid !== e.cid || prior.verifiedWith !== e.verifiedWith
        }),
        removed: base.records
            .filter((e) => !after.has(refKey(e)))
            .map(({ did, collection, rkey }) => ({ did, collection, rkey })),
    }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Wire keys for the summary bodies; a decoder ignores keys it does not know,
 * as with `read-api.ts`.
 */
type FieldsOf<T> = T extends unknown ? keyof T : never
type WireKeys<T> = { readonly [K in FieldsOf<T>]: string }

export const SUMMARY_DELTA_KEYS = {
    token: "t",
    full: "f",
    graph: "g",
    ownBlocks: "b",
    records: "r",
    removed: "x",
    more: "m",
    truncated: "n",
} as const satisfies WireKeys<SummaryDelta>

export const SUMMARY_RECORD_KEYS = {
    did: "d",
    collection: "c",
    rkey: "k",
    cid: "i",
    verifiedWith: "v",
    car: "b",
} as const satisfies WireKeys<SummaryRecord>

export function encodeSummaryDelta(delta: SummaryDelta): Uint8Array {
    const R = SUMMARY_RECORD_KEYS
    const ref = (r: SummaryRecordRef): Map<string, CoseValue> =>
        new Map<string, CoseValue>([
            [R.did, r.did],
            [R.collection, r.collection],
            [R.rkey, r.rkey],
        ])
    return encodeCose(
        new Map<string, CoseValue>([
            [SUMMARY_DELTA_KEYS.token, delta.token],
            [SUMMARY_DELTA_KEYS.full, delta.full],
            [SUMMARY_DELTA_KEYS.graph, delta.graph === null ? null : graphToCose(delta.graph)],
            [
                SUMMARY_DELTA_KEYS.ownBlocks,
                delta.ownBlocks === null
                    ? null
                    : delta.ownBlocks.map(
                          (b) =>
                              new Map<string, CoseValue>([
                                  [OWN_BLOCK_KEYS.did, b.did],
                                  [OWN_BLOCK_KEYS.rkey, b.rkey],
                              ])
                      ),
            ],
            [
                SUMMARY_DELTA_KEYS.records,
                delta.records.map((r) => {
                    const m = ref(r)
                    m.set(R.cid, r.cid)
                    m.set(R.verifiedWith, r.verifiedWith)
                    m.set(R.car, r.car)
                    return m
                }),
            ],
            [SUMMARY_DELTA_KEYS.removed, delta.removed.map(ref)],
            [SUMMARY_DELTA_KEYS.more, delta.more],
            [SUMMARY_DELTA_KEYS.truncated, delta.truncated],
        ])
    )
}

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeSummaryDelta(bytes: Uint8Array): SummaryDelta {
    const D = SUMMARY_DELTA_KEYS
    const R = SUMMARY_RECORD_KEYS
    const map = decodeCoseMap(bytes)
    const str = (m: Map<number | string, CoseValue>, key: string): string => {
        const v = m.get(key)
        if (typeof v !== "string") throw new Error(`summary: missing or malformed "${key}"`)
        return v
    }
    const items = (key: string): Map<number | string, CoseValue>[] => {
        const list = map.get(key)
        if (!Array.isArray(list) || !list.every((i) => i instanceof Map)) {
            throw new Error(`summary: missing or malformed "${key}"`)
        }
        return list as Map<number | string, CoseValue>[]
    }
    const refOf = (m: Map<number | string, CoseValue>): SummaryRecordRef => ({
        did: str(m, R.did),
        collection: str(m, R.collection),
        rkey: str(m, R.rkey),
    })
    const full = map.get(D.full)
    if (typeof full !== "boolean") throw new Error("summary: missing or malformed full")
    const graph = map.get(D.graph)
    if (graph !== null && !(graph instanceof Map)) throw new Error("summary: malformed graph")
    const blocks = map.get(D.ownBlocks)
    if (blocks !== undefined && blocks !== null) {
        if (!Array.isArray(blocks) || !blocks.every((i) => i instanceof Map)) {
            throw new Error("summary: malformed own blocks")
        }
    }
    return {
        token: str(map, D.token),
        full,
        graph: graph === null ? null : graphFromCose(graph),
        ownBlocks:
            blocks === undefined || blocks === null
                ? null
                : (blocks as Map<number | string, CoseValue>[]).map((m) => ({
                      did: str(m, OWN_BLOCK_KEYS.did),
                      rkey: str(m, OWN_BLOCK_KEYS.rkey),
                  })),
        records: items(D.records).map((m) => {
            const car = m.get(R.car)
            if (!(car instanceof Uint8Array)) throw new Error("summary: missing or malformed car")
            return {
                ...refOf(m),
                cid: str(m, R.cid),
                verifiedWith: str(m, R.verifiedWith),
                car,
            }
        }),
        removed: items(D.removed).map(refOf),
        more: map.get(D.more) === true,
        truncated: map.get(D.truncated) === true,
    }
}
