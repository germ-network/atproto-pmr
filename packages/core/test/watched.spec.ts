/**
 * `MONITOR_COLLECTIONS` decides what a monitor snapshots. A misread value
 * watches less than intended and nothing reports it, so the parser refuses
 * anything it cannot read exactly, and says which entry it refused.
 */
import { describe, expect, it } from "vitest"
import { parseMonitorCollections } from "../src/watched"

/** The error must quote the offending entry. */
function refuses(raw: string, entry: string): void {
    expect(() => parseMonitorCollections(raw)).toThrow(`"${entry}"`)
}

describe("parseMonitorCollections", () => {
    it("reads each <nsid>/<rkey> entry, in order", () => {
        expect(
            parseMonitorCollections("app.bsky.actor.profile/self,app.bsky.actor.status/self")
        ).toEqual([
            { collection: "app.bsky.actor.profile", rkey: "self" },
            { collection: "app.bsky.actor.status", rkey: "self" },
        ])
    })

    it("ignores whitespace around entries", () => {
        expect(
            parseMonitorCollections(" app.bsky.actor.profile/self , app.bsky.actor.status/self ")
        ).toEqual([
            { collection: "app.bsky.actor.profile", rkey: "self" },
            { collection: "app.bsky.actor.status", rkey: "self" },
        ])
    })

    it("refuses an empty list", () => {
        expect(() => parseMonitorCollections("")).toThrow(/empty/)
        expect(() => parseMonitorCollections("   ")).toThrow(/empty/)
    })

    it("refuses an empty entry, such as a trailing comma", () => {
        refuses("app.bsky.actor.profile/self,", "")
        refuses(" , ", "")
    })

    it("refuses an entry without exactly one rkey", () => {
        refuses("app.bsky.actor.profile", "app.bsky.actor.profile")
        refuses("app.bsky.actor.profile/", "app.bsky.actor.profile/")
        refuses("/self", "/self")
        refuses(
            "app.bsky.actor.profile/self/x",
            "app.bsky.actor.profile/self/x"
        )
    })

    it("refuses a collection that is not an NSID", () => {
        refuses("declaration/self", "declaration/self")
        refuses("com..declaration/self", "com..declaration/self")
        refuses("app.bsky.9profile/self", "app.bsky.9profile/self")
    })

    it("refuses an rkey outside the record-key syntax", () => {
        refuses("app.bsky.actor.profile/.", "app.bsky.actor.profile/.")
        refuses("app.bsky.actor.profile/..", "app.bsky.actor.profile/..")
        refuses("app.bsky.actor.profile/se lf", "app.bsky.actor.profile/se lf")
    })

    it("refuses the declaration, which MONITOR_COLLECTION watches with its own push", () => {
        refuses(
            "app.bsky.actor.profile/self,com.germnetwork.declaration/self",
            "com.germnetwork.declaration/self"
        )
        refuses("com.germnetwork.declaration/other", "com.germnetwork.declaration/other")
    })

    it("refuses a duplicate entry", () => {
        refuses(
            "app.bsky.actor.profile/self,app.bsky.actor.profile/self",
            "app.bsky.actor.profile/self"
        )
    })
})
