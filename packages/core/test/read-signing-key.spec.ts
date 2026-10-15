/**
 * A public read serves a snapshot only while its ingest key is the DID's
 * trusted current key; it never fetches one, so with none trusted a did:plc
 * read fails closed and a did:web read relies on the ingest verdict.
 */
import { describe, it } from "vitest"

describe("readSigningKeyFrom", () => {
    it.todo("a did:plc document fetched within the continuous coverage run, coverage current, is trusted however old")
    it.todo("a did:plc document fetched before continuousSinceMs is trusted only for SIGNING_KEY_TTL_MS")
    it.todo("coverage lagging past PLC_COVERAGE_MAX_LAG_MS trusts only for SIGNING_KEY_TTL_MS")
    it.todo("no cached document, or one past its window, is unknown")
    it.todo("a document with no #atproto key is unknown")
    it.todo("a did:web DID is unchecked, whatever is cached")
})

describe("servableUnderRotation", () => {
    it.todo("a trusted key equal to verifiedWith is servable")
    it.todo("a trusted key different from verifiedWith is not")
    it.todo("unknown is not servable")
    it.todo("unchecked is servable")
})
