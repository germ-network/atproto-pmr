/**
 * The read paths' key and index reads cost a few bulk store reads per
 * hundred DIDs or records, and never reach the network or read a CAR.
 */
import { describe, it } from "vitest"

describe("kvReadSigningKeys", () => {
    it.todo("maps every DID asked, reading doc: in bulks of at most 100 and plc:coverage once")
    it.todo("a malformed or missing doc: entry is unknown for did:plc")
    it.todo("a did:web DID is unchecked")
})

describe("kvSummaryIndexReader", () => {
    it.todo("returns each ref's cid, verifiedWith and freshAtMs from metadata, in ref order")
    it.todo("freshAtMs takes a chk: confirmation only at the same rev")
    it.todo("an entry with no verified metadata or no cid reads null")
    it.todo("reads keys in bulks of at most 100")
})
