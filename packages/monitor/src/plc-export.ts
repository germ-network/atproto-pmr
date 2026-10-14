/**
 * The PLC directory's export stream (did:plc spec, "Export Streaming
 * WebSocket"), as the way the monitor's stored `did:plc` documents follow a
 * change as soon as the directory accepts it.
 *
 * An operation for a watched DID is rendered into the document the directory
 * would serve and stored at once. What can't be rendered — a legacy `create`,
 * an unknown type, a malformed operation — owes the DID a re-fetch instead,
 * which re-reads the document from the directory, and withdraws trust in
 * the stored one meanwhile. A tombstone stores "gone".
 *
 * A gap in the stream is not replayed: the monitor's refresh pass re-resolves
 * every watched DID's document on its own cycle, which bounds what a gap can
 * leave stale, and the relay's trust in a stored document is gated on the
 * stream's published coverage, so a gap is never mistaken for "no change".
 *
 * Storing the latest operation's state as the DID's current document rests
 * on an inference, not a spec sentence: operations for one DID arrive in
 * their accepted order ("Bulk Export"), and a recovery that nullifies earlier
 * operations arrives as a later operation ("Key Rotation & Account Recovery").
 */

import { renderPlcDocument, type DidDocument } from "@germ-network/atproto-pmr-core"
import type { DidDocumentSink, MonitorIndex, PlcCursorIndex } from "./storage"

/** What one sequenced operation means for its DID's stored document. */
export type PlcDocumentChange =
    | { kind: "render"; document: DidDocument }
    | { kind: "tombstone" }
    /** Not renderable here: re-read the document from the directory. */
    | { kind: "refetch" }

export interface PlcExportEvent {
    seq: number
    did: string
    /** The directory's `createdAt`: when it accepted the operation. Orders the write. */
    createdAtMs: number
    change: PlcDocumentChange
}

/**
 * Decode one `sequenced_op` frame. Returns `null` when the frame has no usable
 * non-negative integer `seq`, its `did` is not `did:plc:`, its `type` is
 * not `sequenced_op`, or its `createdAt` does not parse — a malformed frame
 * must not break the stream.
 */
export function decodePlcExportFrame(raw: string): PlcExportEvent | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const frame = parsed as Record<string, unknown>

    if (frame.type !== "sequenced_op") return null
    const { seq, did, createdAt } = frame
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null
    if (typeof did !== "string" || !did.startsWith("did:plc:")) return null
    if (typeof createdAt !== "string") return null
    const createdAtMs = Date.parse(createdAt)
    if (Number.isNaN(createdAtMs)) return null

    return { seq, did, createdAtMs, change: changeOf(did, frame.operation) }
}

function changeOf(did: string, operation: unknown): PlcDocumentChange {
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
 * resume, so it is dropped and the next connect starts at the tip. Any other
 * close resumes from the cursor.
 */
export function plcCursorAfterClose(reason: string): PlcCursorAction {
    void reason
    throw new Error("not implemented")
}

export interface PlcIntakeDeps {
    index: MonitorIndex & PlcCursorIndex
    didDocuments: DidDocumentSink
}

export type PlcIntakeDecision = "ignored" | "stored" | "refetch"

/**
 * In the read loop: index I/O only, one frame at a time. For a watched DID,
 * store the rendered document (or tombstone) as of the operation's
 * `createdAt`, or for a re-fetch mark the stored one stale as of it (so no
 * reader keeps trusting a superseded key while the re-fetch is owed or
 * failing); and, unless the DID is
 * confirmed deleted, owe the snapshot a re-fetch at its indexed rev, because
 * what its record verifies against may have changed (and the re-fetch is
 * what re-reads an unrenderable document). The cursor advances last, so a
 * crash replays the operation; every write is idempotent. For any other DID,
 * only the cursor advances.
 */
export async function intakePlcEvent(
    deps: PlcIntakeDeps,
    event: PlcExportEvent
): Promise<PlcIntakeDecision> {
    void deps
    void event
    throw new Error("not implemented")
}
