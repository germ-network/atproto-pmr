/**
 * The PLC directory's export stream, as an invalidation signal for a relay's
 * cached `#atproto` signing keys.
 *
 * A relay caches each sender's signing key with a TTL. For did:plc, every
 * change to that key is a sequenced operation on the directory's export
 * stream (did-plc spec, "Export Streaming WebSocket"), so consuming it lets
 * the cache follow a rotation as soon as it lands rather than when the TTL
 * runs out. The TTL stays the backstop: a gap in the stream (a reconnect
 * from the tip, an outdated cursor) costs at most one TTL of staleness, so
 * nothing here has to replay or purge to recover.
 *
 * Only the current `plc_operation` format is read for its key. A legacy
 * `create`, a tombstone, or anything unexpected becomes a delete, so the
 * next resolve fetches the DID document from the directory instead.
 */

import type { KeyUpdateIndex, MonitorIndex, SigningKeyCacheWriter } from "./storage"

/** What one sequenced operation means for its DID's cached `#atproto` key. */
export type SigningKeyUpdate =
    /**
     * `plc_operation`: the `z…` multikey from `verificationMethods.atproto`,
     * or null when it has none. `asOfMs` is the op's `createdAt`, so a key
     * learned from a replayed op is already stale to the relay and is
     * re-fetched rather than trusted as current.
     */
    | { kind: "put"; key: string | null; asOfMs: number }
    | { kind: "delete" }

export interface PlcExportEvent {
    seq: number
    did: string
    update: SigningKeyUpdate
}

/**
 * Decode one `sequenced_op` frame. Returns `null` when there is no usable
 * `seq` or `did` — a malformed frame must not break the stream.
 */
export function decodePlcExportFrame(raw: string): PlcExportEvent | null {
    void raw
    throw new Error("not implemented")
}

/** What a stream close means for the stored cursor. */
export type PlcCursorAction = "keep" | "reset"

/**
 * `OutdatedCursor` and `FutureCursor` mean the stored cursor can never
 * resume, so it is dropped and the next connect starts at the tip. Any
 * other close resumes from the cursor.
 */
export function plcCursorAfterClose(reason: string): PlcCursorAction {
    void reason
    throw new Error("not implemented")
}

export type PlcIntakeDecision = "ignored" | "owed"

/**
 * In the read loop: index lookups only. For a watched DID, owe the snapshot
 * re-fetch (when it is in `revs`) and then the key update together with the
 * cursor, so a crash in between replays the op rather than losing it. For
 * any other DID, only the cursor advances.
 */
export async function intakePlcEvent(
    index: MonitorIndex & KeyUpdateIndex,
    event: PlcExportEvent
): Promise<PlcIntakeDecision> {
    void index
    void event
    throw new Error("not implemented")
}

export interface DrainKeyUpdatesDeps {
    index: KeyUpdateIndex
    cache: SigningKeyCacheWriter
    nowMs(): number
}

/**
 * Apply up to `limit` owed key updates to the cache; a put is stamped
 * `fetchedAtMs = min(asOfMs, nowMs())`. A cache failure leaves
 * the update owed for the next drain. Resolves the number applied.
 */
export async function drainKeyUpdates(
    deps: DrainKeyUpdatesDeps,
    limit: number
): Promise<number> {
    void deps
    void limit
    throw new Error("not implemented")
}
