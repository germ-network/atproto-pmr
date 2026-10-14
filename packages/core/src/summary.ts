/**
 * The owner's summary: their graph plus the full proof CAR of every watched
 * record of every DID in it, so a device holds what it needs without
 * querying record by record. A read names the summary state the client
 * already holds by its token, and gets only what changed since; an unknown
 * token gets the whole summary. The indices behind recent tokens are private
 * state on the owner's registration.
 */

import { encodeGraphReadResponse, type GraphProjectionStore } from "./device-read.js"
import type { GraphReadResponse } from "./read-api.js"
import { readRecordFromCar } from "./repo-proof.js"
import type { RecordSnapshotStore } from "./snapshot-read.js"
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

/** Enough of a summary to diff against: the graph and each record's state. */
export interface SummaryIndex {
    graph: GraphReadResponse
    records: SummaryIndexEntry[]
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
    /** Records added, or whose CID or verifying key changed. */
    records: SummaryRecord[]
    /** Records in the named state no longer in the summary, including any no longer verified. */
    removed: SummaryRecordRef[]
}

/** How many served summary states a registration can name back. */
export const SUMMARY_TOKENS_KEPT = 4

export interface SummaryDeps {
    projections: GraphProjectionStore
    records: RecordSnapshotStore
    /** Every singleton this PMR snapshots, the declaration included. */
    watched: WatchedRecord[]
}

/**
 * The summary for `did` as held now: the owner's projection, and every
 * watched record of the owner and of each DID in it that is held, was
 * verified at ingest and parses. `records` carries each one's CAR from the
 * same read that produced its index entry, so the bytes served always match
 * the index stored under the token. Null when the owner has no projection
 * yet. Never requests a re-check, whatever a declaration's age: one owner's
 * sync must not fan out to their peers' PDSes.
 */
export async function buildSummary(
    did: string,
    deps: SummaryDeps
): Promise<{ index: SummaryIndex; records: SummaryRecord[] } | null> {
    const graph = await deps.projections.get(did)
    if (!graph) return null
    const dids = [
        ...new Set([did, ...graph.following.map((e) => e.did), ...graph.followers.map((e) => e.did)]),
    ]
    const held = await Promise.all(
        dids.flatMap((d) => deps.watched.map((w) => readSummaryRecord(d, w, deps.records)))
    )
    const records = held
        .filter((r): r is SummaryRecord => r !== null)
        .sort(
            (a, b) =>
                compareStrings(a.did, b.did) ||
                compareStrings(a.collection, b.collection) ||
                compareStrings(a.rkey, b.rkey)
        )
    return {
        index: {
            graph,
            records: records.map(({ car: _car, ...entry }) => entry),
        },
        records,
    }
}

async function readSummaryRecord(
    did: string,
    watched: WatchedRecord,
    store: RecordSnapshotStore
): Promise<SummaryRecord | null> {
    const snapshot = await store.get(did, watched.collection, watched.rkey)
    if (!snapshot || snapshot.verifiedWith === null) return null
    let parsed
    try {
        parsed = readRecordFromCar(snapshot.car, watched.collection, watched.rkey)
    } catch {
        return null
    }
    if (!parsed || parsed.did !== did) return null
    return {
        did,
        collection: watched.collection,
        rkey: watched.rkey,
        cid: parsed.cid,
        verifiedWith: snapshot.verifiedWith,
        car: snapshot.car,
    }
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

const refKey = (r: SummaryRecordRef) => JSON.stringify([r.did, r.collection, r.rkey])

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
    changed: SummaryIndexEntry[]
    removed: SummaryRecordRef[]
} {
    if (!base) {
        return { full: true, graphChanged: true, changed: current.records, removed: [] }
    }
    const before = new Map(base.records.map((e) => [refKey(e), e]))
    const after = new Set(current.records.map(refKey))
    return {
        full: false,
        graphChanged: !equalBytes(
            encodeGraphReadResponse(base.graph),
            encodeGraphReadResponse(current.graph)
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
    records: "r",
    removed: "x",
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
    throw new Error("not implemented")
}

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeSummaryDelta(bytes: Uint8Array): SummaryDelta {
    throw new Error("not implemented")
}
