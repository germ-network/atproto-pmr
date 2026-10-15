/**
 * The device read API's public record route (`spec/wire-api.md`, "Device reads"), served
 * from the monitor's processed KV output. It is unauthenticated and answers
 * every caller identically, so a response says nothing about who else has
 * asked. It never reaches a PDS on the response path.
 */

import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import { DECLARATION_COLLECTION_NSID } from "./declaration.js"
import {
    RECORD_READ_KEYS,
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
