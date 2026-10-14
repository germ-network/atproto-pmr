/**
 * The PLC directory's export stream, as the way the monitor's cached
 * `did:plc` data follows a change as soon as the directory accepts it.
 *
 * Two caches read it. A relay caches each sender's `#atproto` signing key
 * with a TTL; for did:plc, every change to that key is a sequenced operation
 * on the directory's export stream (did-plc spec, "Export Streaming
 * WebSocket"), so the key cache can follow a rotation as soon as it lands.
 * And the monitor keeps a stored DID document per watched DID: an operation
 * for a watched DID is rendered into the document the directory would serve
 * and stored at once. What can't be rendered — a legacy `create`, an unknown
 * type, a malformed operation — withdraws trust in the stored document (and
 * a key delete) so the next read re-fetches it from the directory; a
 * tombstone stores "gone".
 *
 * A gap in the stream (a reconnect from the tip, an outdated cursor) is not
 * replayed: the TTL backstops the key cache, the monitor's refresh pass
 * re-resolves every watched DID's document on its own cycle, and the relay's
 * trust in a stored document is gated on the stream's published coverage, so
 * a gap is never mistaken for "no change".
 *
 * Storing the latest operation's state as the DID's current document rests
 * on an inference, not a spec sentence: operations for one DID arrive in
 * their accepted order ("Bulk Export"), and a recovery that nullifies earlier
 * operations arrives as a later operation ("Key Rotation & Account Recovery").
 */

import { renderPlcDocument, type DidDocument } from "@germ-network/atproto-pmr-core"
import type {
    DidDocumentSink,
    KeyUpdateIndex,
    MonitorIndex,
    SigningKeyCacheWriter,
} from "./storage"

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

/** What one sequenced operation means for its DID's stored document. */
export type PlcDocumentChange =
    | { kind: "render"; document: DidDocument }
    | { kind: "tombstone" }
    /** Not renderable here: re-read the document from the directory. */
    | { kind: "refetch" }

export interface PlcExportEvent {
    seq: number
    did: string
    /**
     * The directory's `createdAt`: when it accepted the operation, which
     * orders the document write. Null when the frame's was missing or
     * unparseable; the change is then a re-fetch.
     */
    createdAtMs: number | null
    update: SigningKeyUpdate
    change: PlcDocumentChange
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
    const createdAt =
        typeof frame.createdAt === "string" ? Date.parse(frame.createdAt) : Number.NaN
    const createdAtMs = Number.isNaN(createdAt) ? null : createdAt
    return {
        seq,
        did,
        createdAtMs,
        update: updateOf(frame, createdAtMs),
        change: changeOf(did, frame.operation, createdAtMs),
    }
}

const DID_KEY_PREFIX = "did:key:"

function updateOf(frame: Record<string, unknown>, asOfMs: number | null): SigningKeyUpdate {
    const op = frame.operation
    if (typeof op !== "object" || op === null) return { kind: "delete" }
    const operation = op as Record<string, unknown>
    if (operation.type !== "plc_operation") return { kind: "delete" }
    if (asOfMs === null) return { kind: "delete" }

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

function changeOf(
    did: string,
    operation: unknown,
    createdAtMs: number | null
): PlcDocumentChange {
    if (createdAtMs === null) return { kind: "refetch" }
    const type =
        typeof operation === "object" && operation !== null
            ? (operation as { type?: unknown }).type
            : undefined
    if (type === "plc_tombstone") return { kind: "tombstone" }
    if (type === "plc_operation") {
        const document = renderPlcDocument(did, operation)
        if (document !== null) return { kind: "render", document }
    }
    return { kind: "refetch" }
}

/** What a stream close means for the stored cursor. */
export type PlcCursorAction = "keep" | "reset"

/**
 * `OutdatedCursor` and `FutureCursor` mean the stored cursor can never
 * resume, so it is dropped and the next connect starts at the tip. Any
 * other close resumes from the cursor.
 */
export function plcCursorAfterClose(reason: string): PlcCursorAction {
    return reason === "OutdatedCursor" || reason === "FutureCursor" ? "reset" : "keep"
}

export type PlcIntakeDecision = "ignored" | "owed"

/**
 * In the read loop: index lookups and the document sink only. For a watched
 * DID, store the rendered document (or tombstone) as of the operation's
 * `createdAt`, or for a re-fetch mark the stored one stale as of it (so no
 * reader keeps trusting a superseded key while the re-fetch is owed or
 * failing); then owe the snapshot re-fetch (when it is in `revs`) and,
 * last, the key update together with the cursor, so a crash in between
 * replays the op rather than losing it — every write is idempotent. For any
 * other DID, only the cursor advances. Without `didDocuments` the stored
 * documents are left alone.
 */
export async function intakePlcEvent(
    index: MonitorIndex & KeyUpdateIndex,
    event: PlcExportEvent,
    didDocuments?: DidDocumentSink
): Promise<PlcIntakeDecision> {
    const createdAt = event.createdAtMs ?? undefined
    if (!(await index.isWatched(event.did))) {
        await index.advancePlcCursor(event.seq, createdAt)
        return "ignored"
    }
    if (didDocuments !== undefined) {
        const asOfMs = event.createdAtMs ?? Date.now()
        const { change } = event
        if (change.kind === "refetch") {
            await didDocuments.markDidDocumentStale(event.did, asOfMs)
        } else {
            const document = change.kind === "render" ? change.document : null
            await didDocuments.recordDidDocument(event.did, document, asOfMs)
        }
    }
    const rev = await index.revOf(event.did)
    if (rev !== null) await index.owe(event.did, rev)
    await index.oweKeyUpdate(event.did, event.update, event.seq, createdAt)
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
