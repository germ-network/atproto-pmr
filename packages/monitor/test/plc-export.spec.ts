/**
 * The PLC export stream as a signing-key cache signal: decode, intake in the
 * read loop, and the drain that reaches the cache.
 */
import { describe, it } from "vitest"

describe("decodePlcExportFrame (S1)", () => {
    it.todo("plc_operation → put with verificationMethods.atproto minus the did:key: prefix, asOfMs = createdAt")
    it.todo("plc_operation with a missing or unparseable createdAt → delete")
    it.todo("plc_operation without verificationMethods.atproto → put null")
    it.todo("plc_operation whose atproto value is not a did:key:z… string → delete")
    it.todo("legacy create → delete, not a key read from signingKey")
    it.todo("plc_tombstone → delete")
    it.todo("unknown operation type → delete")
    it.todo("carries seq and did from the frame")
    it.todo("non-JSON, missing or non-integer seq, missing did, or a non-did:plc did → null")
    it.todo("type other than sequenced_op → null")
    it.todo("a captured live sequenced_op frame decodes to its seq, did and key")
})

describe("intakePlcEvent (S2)", () => {
    it.todo("unwatched DID → ignored, only the cursor advances, nothing owed")
    it.todo("DID in revs → owes the snapshot re-fetch at its indexed rev and the key update with the cursor")
    it.todo("DID only in pending → owes the key update with the cursor, no extra owe")
    it.todo("permanently deleted DID → ignored")
    it.todo("the re-fetch is owed before the key update and cursor, so a crash between them replays the op")
})

describe("drainKeyUpdates (S3)", () => {
    it.todo("put → cache.put with the key and fetchedAtMs = min(asOfMs, nowMs()), then cleared")
    it.todo("delete → cache.delete, then cleared")
    it.todo("respects limit")
    it.todo("a cache failure leaves the update owed and resolves the count applied so far")
    it.todo("an update replaced during the drain is not cleared")
})

describe("plcCursorAfterClose (S4)", () => {
    it.todo("OutdatedCursor and FutureCursor → reset")
    it.todo("ConsumerTooSlow, an empty reason, or anything else → keep")
})
