/**
 * The PLC export stream: decoding an operation into what it means for the
 * DID's stored document, the cursor's fate on close, and the read-loop intake
 * that acts only on watched DIDs.
 */
import { describe, it } from "vitest"

describe("decodePlcExportFrame", () => {
    it.todo("a plc_operation decodes to render, with the document renderPlcDocument gives for it")
    it.todo("a plc_tombstone decodes to tombstone")
    it.todo("a legacy create decodes to refetch")
    it.todo("an unknown operation type decodes to refetch")
    it.todo("a plc_operation that does not render decodes to refetch")
    it.todo("keeps seq and did from the frame, and createdAt as createdAtMs")
    it.todo("returns null for an unparseable createdAt")
    it.todo("returns null for a missing, negative, fractional or unsafe seq")
    it.todo("returns null for a did that is not did:plc:")
    it.todo("returns null when type is not sequenced_op")
    it.todo("returns null for text that is not a JSON object")
})

describe("plcCursorAfterClose", () => {
    it.todo("OutdatedCursor resets the cursor")
    it.todo("FutureCursor resets the cursor")
    it.todo("ConsumerTooSlow keeps the cursor")
    it.todo("an empty or unknown reason keeps the cursor")
})

describe("intakePlcEvent", () => {
    it.todo("an unwatched DID only advances the cursor, and answers ignored")
    it.todo("a watched DID's render is stored as of the op's createdAt, and answers stored")
    it.todo("a watched DID's tombstone stores a null document, and answers stored")
    it.todo("a watched DID's refetch marks the stored document stale as of the op's createdAt, and answers refetch")
    it.todo("a confirmed-deleted DID's refetch still marks the stored document stale")
    it.todo("any change for a DID in the rev index owes a snapshot re-fetch at its indexed rev")
    it.todo("a confirmed-deleted DID's render is stored but no re-fetch is owed")
    it.todo("a watched DID that is only owed a fetch is not owed again")
    it.todo("advances the cursor after the document and the obligation are written")
    it.todo("a failed document write leaves the cursor where it was")
})
