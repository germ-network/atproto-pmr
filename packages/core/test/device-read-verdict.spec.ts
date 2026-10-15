/**
 * A record read serves the rev and CID ingest verified, and never a snapshot
 * signed under a key the DID has rotated away from.
 */
import { describe, it } from "vitest"

describe("handleRecordRead verdict", () => {
    it.todo("rev and cid come from the snapshot's verified metadata, not a parse of the CAR")
    it.todo("a verified entry with a null rev or cid falls back to the parse")
    it.todo("a snapshot whose verifiedWith is not the trusted current key reads unverifiable")
    it.todo("a did:plc DID with no trusted current key reads unverifiable")
    it.todo("a did:web DID is served on its ingest verdict")
    it.todo("the key is read only for a DID that is served and held")
})
