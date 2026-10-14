/**
 * The owner's summary: their graph plus the full proof CAR of every watched
 * record of every DID in it, so a device holds what it needs without
 * querying record by record. A read names the summary state the client
 * already holds by its token, and gets only what changed since; an unknown
 * token gets the whole summary. The indices behind recent tokens are private
 * state on the owner's registration.
 */

import type { GraphProjectionStore } from "./device-read.js"
import type { GraphReadResponse } from "./read-api.js"
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
    throw new Error("not implemented")
}

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
    throw new Error("not implemented")
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
