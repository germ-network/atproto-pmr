/**
 * The device read API's public routes (`spec/proxy-cache.md`): records and
 * the follow graph, served from the monitor's processed KV output. Both are
 * unauthenticated and answer every caller identically, so a response says
 * nothing about who else has asked. Neither route reaches a PDS on the
 * response path.
 */

import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import { DECLARATION_COLLECTION_NSID } from "./declaration.js"
import type { FollowEdge } from "./follow-edges.js"
import {
    GRAPH_EDGE_KEYS,
    GRAPH_READ_KEYS,
    RECORD_READ_KEYS,
    type GraphEdge,
    type GraphReadResponse,
    type RecordReadMiss,
    type RecordReadResponse,
} from "./read-api.js"
import { servableUnderRotation, type ReadSigningKeys } from "./read-signing-key.js"
import { readRecordFromCar } from "./repo-proof.js"
import { SNAPSHOT_MAX_AGE_MS, type RecordSnapshotStore } from "./snapshot-read.js"
import { toResponseBody } from "./util.js"
import type { WatchedRecord } from "./watched.js"

export interface RecordReadDeps {
    records: RecordSnapshotStore
    /**
     * Whether this deployment serves `did`'s records: its interest set, by
     * default registered users and the DIDs they follow; a private
     * deployment may serve everyone. Any other DID reads `not-watched`,
     * whatever is held.
     */
    serves: (did: string) => Promise<boolean>
    /** Every singleton this PMR snapshots, the declaration included. */
    watched: WatchedRecord[]
    /**
     * The DID's current key: a snapshot ingest verified under any other key,
     * or with no trusted current key for a `did:plc` DID, reads `unverifiable`.
     */
    signingKeys: ReadSigningKeys
    nowMs: () => number
    /**
     * Asks the monitor to re-check a declaration whose snapshot is past
     * `SNAPSHOT_MAX_AGE_MS`. Runs off the response path: the response never
     * depends on it, and a failure is logged, not surfaced.
     */
    requestRecheck: (did: string) => Promise<void>
    waitUntil: (promise: Promise<unknown>) => void
}

/**
 * Wraps `requestRecheck` with a per-isolate memo, so a burst of reads of one
 * lapsed declaration becomes one request to the monitor within `windowMs`,
 * and one log line: a lapse means the monitor is over 24 h behind, an
 * operational alarm. Bounded; the oldest entry goes first. A request that
 * fails is not retried within the window. Build it once per isolate: a memo
 * built per request dedupes nothing.
 */
export function dedupedRecheck(
    requestRecheck: (did: string) => Promise<void>,
    nowMs: () => number,
    windowMs: number,
    maxEntries = RECHECK_MEMO_MAX
): (did: string) => Promise<void> {
    const requestedAt = new Map<string, number>()
    return async (did) => {
        const now = nowMs()
        const last = requestedAt.get(did)
        if (last !== undefined && now - last < windowMs) return
        requestedAt.delete(did)
        if (requestedAt.size >= maxEntries) {
            requestedAt.delete(requestedAt.keys().next().value!)
        }
        requestedAt.set(did, now)
        console.warn(`declaration snapshot past ${SNAPSHOT_MAX_AGE_MS} ms; requesting re-check`, did)
        await requestRecheck(did)
    }
}

const RECHECK_MEMO_MAX = 1024

/**
 * `GET /pmr/v1/records/{did}/{collection}/{rkey}` — the held snapshot's CAR,
 * byte for byte, in a CBOR {@link RecordReadResponse}; `200` whether found or
 * not, with `cache-control: no-store` and no validators, so no cache can tell
 * one caller that another read the record. Held bytes are served without a
 * per-read signature check: `rev` and `cid` are the ones ingest verified (a
 * parse of the CAR only for an entry stored without them), and an entry
 * ingest did not verify reads as `unverifiable`.
 * The declaration is always in the watched set, but like any record it is
 * served only for DIDs the deployment serves.
 */
export async function handleRecordRead(
    request: Request,
    deps: RecordReadDeps
): Promise<Response> {
    const target = parseRecordPath(new URL(request.url).pathname)
    if (!target) {
        return new Response("Malformed path", {
            status: 400,
            headers: { "cache-control": "no-store" },
        })
    }
    const { did, collection, rkey } = target

    const watched =
        isDeclaration(collection, rkey) ||
        deps.watched.some((w) => w.collection === collection && w.rkey === rkey)
    if (!watched || !(await deps.serves(did))) {
        return recordResponse({ found: false, code: "not-watched", reason: "not watched" })
    }

    const snapshot = await deps.records.get(did, collection, rkey)
    if (!snapshot) {
        return recordResponse({ found: false, code: "not-held", reason: "no snapshot held" })
    }
    if (snapshot.verifiedWith === null) {
        return recordResponse(unverifiable("ingest did not verify this snapshot"))
    }
    const key = (await deps.signingKeys.keysFor([did])).get(did) ?? { kind: "unknown" as const }
    if (!servableUnderRotation(snapshot.verifiedWith, key)) {
        return recordResponse(unverifiable("snapshot is not under the DID's current signing key"))
    }
    let verified: { rev: string; cid: string }
    if (snapshot.rev !== null && snapshot.cid !== null) {
        verified = { rev: snapshot.rev, cid: snapshot.cid }
    } else {
        // An entry stored without its metadata: derive it from the CAR.
        let parsed
        try {
            parsed = readRecordFromCar(snapshot.car, collection, rkey)
        } catch {
            return recordResponse(unverifiable("snapshot does not parse"))
        }
        if (parsed && parsed.did !== did) {
            return recordResponse(unverifiable("snapshot is for another DID"))
        }
        if (!parsed) {
            return recordResponse({
                found: false,
                code: "not-held",
                reason: "the held snapshot proves the record absent",
            })
        }
        verified = { rev: parsed.rev, cid: parsed.cid }
    }
    if (
        isDeclaration(collection, rkey) &&
        !(deps.nowMs() - snapshot.freshAtMs <= SNAPSHOT_MAX_AGE_MS)
    ) {
        deps.waitUntil(
            Promise.resolve()
                .then(() => deps.requestRecheck(did))
                .catch((error) => console.warn("re-check request failed", did, error))
        )
    }
    return recordResponse({
        found: true,
        car: snapshot.car,
        rev: verified.rev,
        cid: verified.cid,
        freshAtMs: snapshot.freshAtMs,
    })
}

function unverifiable(reason: string): RecordReadResponse {
    return { found: false, code: "unverifiable", reason }
}

function isDeclaration(collection: string, rkey: string): boolean {
    return collection === DECLARATION_COLLECTION_NSID && rkey === "self"
}

// A DID names store keys, so anything that could escape a key segment is refused.
export const DID_SYNTAX = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/

function parseRecordPath(
    pathname: string
): { did: string; collection: string; rkey: string } | null {
    const parts = pathname.split("/")
    // "", "pmr", "v1", "records", did, collection, rkey
    if (parts.length !== 7 || parts[1] !== "pmr" || parts[2] !== "v1" || parts[3] !== "records") {
        return null
    }
    try {
        const [did, collection, rkey] = parts.slice(4).map(decodeURIComponent)
        if (!DID_SYNTAX.test(did) || !collection || !rkey) return null
        return { did, collection, rkey }
    } catch {
        return null
    }
}

function recordResponse(body: RecordReadResponse): Response {
    return new Response(toResponseBody(encodeRecordReadResponse(body)), {
        status: 200,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
    })
}

export function encodeRecordReadResponse(response: RecordReadResponse): Uint8Array {
    const K = RECORD_READ_KEYS
    const entries: [string, CoseValue][] = response.found
        ? [
              [K.found, true],
              [K.car, response.car],
              [K.rev, response.rev],
              [K.cid, response.cid],
              [K.freshAtMs, response.freshAtMs],
          ]
        : [
              [K.found, false],
              [K.code, response.code],
              [K.reason, response.reason],
          ]
    return encodeCose(new Map(entries))
}

const RECORD_READ_MISSES: readonly RecordReadMiss[] = ["not-watched", "not-held", "unverifiable"]

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeRecordReadResponse(bytes: Uint8Array): RecordReadResponse {
    const K = RECORD_READ_KEYS
    const map = decodeCoseMap(bytes)
    const field = <T>(key: string, ok: (v: unknown) => v is T): T => {
        const v = map.get(key)
        if (!ok(v)) throw new Error(`record read: missing or malformed field "${key}"`)
        return v
    }
    const isString = (v: unknown): v is string => typeof v === "string"
    if (field(K.found, (v): v is boolean => typeof v === "boolean")) {
        return {
            found: true,
            car: field(K.car, (v): v is Uint8Array => v instanceof Uint8Array),
            rev: field(K.rev, isString),
            cid: field(K.cid, isString),
            freshAtMs: field(K.freshAtMs, (v): v is number => Number.isSafeInteger(v)),
        }
    }
    return {
        found: false,
        code: field(K.code, (v): v is RecordReadMiss =>
            RECORD_READ_MISSES.includes(v as RecordReadMiss)
        ),
        reason: field(K.reason, isString),
    }
}

/**
 * The owner's graph from the index's edges, which the index has already
 * restricted to declaration holders: an edge is `mutual` iff a reverse edge
 * is also present. Two follow records of the same pair are two edges. Edges
 * come back sorted by `did` then `rkey`, so equal inputs encode to equal
 * bytes.
 */
export function projectGraph(
    did: string,
    following: FollowEdge[],
    followers: FollowEdge[]
): GraphReadResponse {
    const followingDids = new Set(following.map((e) => e.subject))
    const followerDids = new Set(followers.map((e) => e.follower))
    return {
        did,
        following: sortEdges(
            following.map((e) => ({
                did: e.subject,
                rkey: e.rkey,
                mutual: followerDids.has(e.subject),
            }))
        ),
        followers: sortEdges(
            followers.map((e) => ({
                did: e.follower,
                rkey: e.rkey,
                mutual: followingDids.has(e.follower),
            }))
        ),
    }
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
    return edges.sort((a, b) => compareStrings(a.did, b.did) || compareStrings(a.rkey, b.rkey))
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

export function encodeGraphReadResponse(response: GraphReadResponse): Uint8Array {
    return encodeCose(graphToCose(response))
}

/** The graph as a CBOR map, for embedding in another body. */
export function graphToCose(response: GraphReadResponse): Map<string, CoseValue> {
    const edges = (list: GraphEdge[]): CoseValue[] =>
        list.map(
            (e) =>
                new Map<string, CoseValue>([
                    [GRAPH_EDGE_KEYS.did, e.did],
                    [GRAPH_EDGE_KEYS.rkey, e.rkey],
                    [GRAPH_EDGE_KEYS.mutual, e.mutual],
                ])
        )
    return new Map<string, CoseValue>([
        [GRAPH_READ_KEYS.did, response.did],
        [GRAPH_READ_KEYS.following, edges(response.following)],
        [GRAPH_READ_KEYS.followers, edges(response.followers)],
    ])
}

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeGraphReadResponse(bytes: Uint8Array): GraphReadResponse {
    return graphFromCose(decodeCoseMap(bytes))
}

export function graphFromCose(map: Map<number | string, CoseValue>): GraphReadResponse {
    const did = map.get(GRAPH_READ_KEYS.did)
    if (typeof did !== "string") throw new Error("graph read: missing or malformed did")
    const edges = (key: string): GraphEdge[] => {
        const list = map.get(key)
        if (!Array.isArray(list)) throw new Error(`graph read: missing or malformed "${key}"`)
        return list.map((item) => {
            if (!(item instanceof Map)) throw new Error("graph read: malformed edge")
            const edgeDid = item.get(GRAPH_EDGE_KEYS.did)
            const rkey = item.get(GRAPH_EDGE_KEYS.rkey)
            const mutual = item.get(GRAPH_EDGE_KEYS.mutual)
            if (
                typeof edgeDid !== "string" ||
                typeof rkey !== "string" ||
                typeof mutual !== "boolean"
            ) {
                throw new Error("graph read: malformed edge")
            }
            return { did: edgeDid, rkey, mutual }
        })
    }
    return {
        did,
        following: edges(GRAPH_READ_KEYS.following),
        followers: edges(GRAPH_READ_KEYS.followers),
    }
}

/**
 * The public graph projections, kept current by the monitor's projector for
 * the DIDs whose graphs this deployment serves: by default its registered
 * users only, never arbitrary DIDs; a private deployment may project every
 * declaration holder. A DID with no projection is not served.
 */
export interface GraphProjectionStore {
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    get(did: string): Promise<GraphReadResponse | null>
}

/** The projector's side of the store. */
export interface GraphProjectionWriter extends GraphProjectionStore {
    put(projection: GraphReadResponse): Promise<void>
    delete(did: string): Promise<void>
    /** Held projections' DIDs, paged, so a rebuild can sweep those no longer served. */
    listDids(
        cursor: string | null,
        limit: number
    ): Promise<{ dids: string[]; cursor: string | null }>
}

export interface GraphReadDeps {
    projections: GraphProjectionStore
}

/**
 * `GET /pmr/v1/graph/{did}` — the DID's held projection as a CBOR
 * {@link GraphReadResponse}, `cache-control: no-store`, `404` when no
 * projection is held for the DID. An aggregation, so an unauthenticated hint: a device verifies
 * an edge against the follower's signed follow record before relying on it.
 */
export async function handleGraphRead(
    request: Request,
    deps: GraphReadDeps
): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/")
    // "", "pmr", "v1", "graph", did
    let did: string | null = null
    if (parts.length === 5 && parts[1] === "pmr" && parts[2] === "v1" && parts[3] === "graph") {
        try {
            const decoded = decodeURIComponent(parts[4])
            if (DID_SYNTAX.test(decoded)) did = decoded
        } catch {
            // malformed escape: same 400 as any other bad path
        }
    }
    if (did === null) {
        return new Response("Malformed path", {
            status: 400,
            headers: { "cache-control": "no-store" },
        })
    }
    const projection = await deps.projections.get(did)
    if (!projection) {
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
    }
    return new Response(toResponseBody(encodeGraphReadResponse(projection)), {
        status: 200,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
    })
}
