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
 * Decode one frame. Returns `null` for anything that is not a `sequenced_op`
 * with a usable `seq` and `did:plc:` DID — a malformed frame must not break
 * the stream.
 */
export function decodePlcExportFrame(raw: string): PlcExportEvent | null {
    let payload: unknown
    try {
        payload = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null
    const frame = payload as Record<string, unknown>
    if (frame.type !== "sequenced_op") return null
    const { seq, did } = frame
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null
    if (typeof did !== "string" || !did.startsWith("did:plc:")) return null
    return { seq, did, update: updateOf(frame) }
}

const DID_KEY_PREFIX = "did:key:"

function updateOf(frame: Record<string, unknown>): SigningKeyUpdate {
    const op = frame.operation
    if (typeof op !== "object" || op === null) return { kind: "delete" }
    const operation = op as Record<string, unknown>
    if (operation.type !== "plc_operation") return { kind: "delete" }
    const asOfMs =
        typeof frame.createdAt === "string" ? Date.parse(frame.createdAt) : Number.NaN
    if (Number.isNaN(asOfMs)) return { kind: "delete" }

    const methods = operation.verificationMethods
    if (methods === undefined) return { kind: "put", key: null, asOfMs }
    if (typeof methods !== "object" || methods === null) return { kind: "delete" }
    const atproto = (methods as Record<string, unknown>).atproto
    if (atproto === undefined) return { kind: "put", key: null, asOfMs }
    if (
        typeof atproto !== "string" ||
        !atproto.startsWith(`${DID_KEY_PREFIX}z`)
    ) {
        return { kind: "delete" }
    }
    return { kind: "put", key: atproto.slice(DID_KEY_PREFIX.length), asOfMs }
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
    if (!(await index.isWatched(event.did))) {
        await index.advancePlcCursor(event.seq)
        return "ignored"
    }
    const rev = await index.revOf(event.did)
    if (rev !== null) await index.owe(event.did, rev)
    await index.oweKeyUpdate(event.did, event.update, event.seq)
    return "owed"
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
    const due = await deps.index.dueKeyUpdates(limit)
    let applied = 0
    for (const { did, update, version } of due) {
        try {
            if (update.kind === "put") {
                await deps.cache.put(did, {
                    key: update.key,
                    fetchedAtMs: Math.min(update.asOfMs, deps.nowMs()),
                })
            } else {
                await deps.cache.delete(did)
            }
        } catch {
            return applied
        }
        await deps.index.clearKeyUpdate(did, version)
        applied++
    }
    return applied
}
