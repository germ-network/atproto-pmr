/**
 * A summary stays within one invocation's store reads: its index is built
 * without reading CARs, a response carries at most a page of CARs and says
 * when more remain, and an owner with too many contacts gets the
 * highest-priority ones and is told so.
 */
import { describe, it } from "vitest"

describe("summaryContacts", () => {
    it.todo("orders the owner, then mutuals, following and followers, each by DID")
    it.todo("a DID in several groups appears once, in its highest group")
    it.todo("cuts at maxContacts and sets truncated; at or under it, it is not set")
})

describe("buildSummaryIndex", () => {
    it.todo("is null when the owner has no projection")
    it.todo("caps contacts at SUMMARY_MAX_RECORDS over the watched count")
    it.todo("reads entries for every covered contact x watched record, and no CAR")
    it.todo("leaves out unheld, unverified and rotation-failed records")
    it.todo("reports a held declaration past SNAPSHOT_MAX_AGE_MS to onLapse and still includes it")
    it.todo("never requests a re-check")
})

describe("readSummaryPage", () => {
    it.todo("with no base, the page is full with no removals")
    it.todo("carries at most limit changed records and sets more when others remain")
    it.todo("pages changed records in (did, collection, rkey) order, the owner's first")
    it.todo("delivered has more set exactly when the page does")
    it.todo("delivered is base minus removals plus the delivered records, with the current graph")
    it.todo("a delivered record's entry is taken from its own CAR read, so bytes match the index")
    it.todo("a record gone or no longer servable at its CAR read is reported removed")
    it.todo("the graph is carried on the first page it changed on, and null after")
    it.todo("paging from each delivered index converges to current with more unset")
})

describe("summary delta codec", () => {
    it.todo("more and truncated round-trip")
    it.todo("a body without more or truncated decodes them as false")
})
