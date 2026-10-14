/**
 * The owner's summary carries the full CARs of their graph's records. A read
 * names the state the client holds and gets only what changed since; a client
 * that names nothing, or a state no longer held, gets everything, so no lost
 * response, lost state or second device leaves a client wrong.
 */
import { describe, it } from "vitest"

describe("buildSummary", () => {
    it.todo("includes every watched record of the owner and of each DID in the owner's projection")
    it.todo("leaves out records not held, not verified at ingest, or whose CAR does not parse")
    it.todo("is null when the owner has no projection")
    it.todo("never requests a recheck, even for a lapsed declaration")
    it.todo("each record's CAR is the bytes whose cid and verifiedWith its index entry records")
})

describe("diffSummaryIndex", () => {
    it.todo("with no base, everything changed and full is set")
    it.todo("an unchanged summary yields nothing changed and graphChanged false")
    it.todo("a record whose CID changed is changed")
    it.todo("a record whose verifiedWith changed with the same CID is changed")
    it.todo("a record no longer in the summary, or no longer verified, is removed")
})

describe("summary read", () => {
    it.todo("an unauthenticated read is 401")
    it.todo("a read with no since returns the full summary and a token")
    it.todo("a full delta has removed empty")
    it.todo("the CARs served are the bytes read when building the index stored under the token")
    it.todo("a read with nothing changed since the named state returns that token and stores nothing new")
    it.todo("returning a named token unchanged makes it the most recent, so other reads do not drop it first")
    it.todo("a read naming a served token returns only what changed since that state, CARs only for changed records")
    it.todo("a record added in one served state and removed later is in removed for a client naming that state")
    it.todo("a read naming an unknown or dropped token returns the full summary")
    it.todo("two clients naming different tokens each get the delta from their own state")
    it.todo("only the last SUMMARY_TOKENS_KEPT served states can be named")
    it.todo("an owner with no projection yet is 409 with Retry-After")
    it.todo("one owner's tokens are unknown to another owner")
})

describe("summary codec", () => {
    it.todo("a delta round-trips through encode and decode")
    it.todo("decode ignores unknown keys")
    it.todo("SUMMARY_DELTA_KEYS and SUMMARY_RECORD_KEYS each give every field a distinct key")
})
