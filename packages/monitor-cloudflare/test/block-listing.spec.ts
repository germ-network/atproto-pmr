/** Listings write and sweep a DID's kept blocks alongside its follows. */
import { describe, it } from "vitest"

describe("listings — blocks", () => {
    it.todo("an owner-repo listing writes the owner's blocks from the same getRepo as its follows")
    it.todo("an owner-repo walk past MAX_BLOCKS switches the owner to pages")
    it.todo("a paged-owner listing lists blocks by listRecords after its follows")
    it.todo("a mutual listing keeps only blocks whose subject is registered")
    it.todo("a completed listing sweeps blocks the repo no longer has")
    it.todo("a live block op logged after the listing began survives its drain and sweep")
    it.todo("a follow and a block sharing an rkey stage, drain and sweep independently")
    it.todo("a DID the owner only blocks is not queued for a followee listing")
    it.todo("worstCaseDrainStatements covers a drain of follows and blocks with both sweeps")
})
