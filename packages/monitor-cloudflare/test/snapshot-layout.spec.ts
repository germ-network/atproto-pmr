/**
 * Every snapshot is a v2 entry: bounded index metadata, plus a value envelope
 * of public detail and the CAR, in one put. Readers serve only v2.
 */
import { describe, it } from "vitest"

describe("snapshot entry layout", () => {
    it.todo("the index metadata at maximal field lengths (253-char monitor host, did:web) fits the KV cap")
    it.todo("a monitor hostname over 253 characters is rejected, so evidence never carries one")
    it.todo("a bulk summary read logs non-v2 entries once per call with a count")
    it.todo("writeEntry throws SnapshotMetadataTooLarge rather than trim when metadata exceeds the cap")
    it.todo("a value envelope round-trips detail and CAR bytes")
    it.todo("decodeSnapshotValue answers null for a truncated or malformed envelope")
    it.todo("a worst-case did:plc declaration round-trips its full evidence")
    it.todo("a worst-case did:web declaration round-trips its full evidence with the document URL derived")
    it.todo("a did:web authority with a bare #atproto method id round-trips")
    it.todo("getRecord serves source and signingKey from the envelope")
    it.todo("the record, summary, declaration and first-seen readers treat a v0.3.0-shape entry as not held and log it")
    it.todo("readers treat an entry with an unknown version as not held")
    it.todo("the declared-key reader answers rev, cid, verifiedWith and CAR for v2 declarations")
    it.todo("a secondary is stored as v2 with no policies, evidence or first-seen")
})
