/** Many-record edge collections are code, not MONITOR_COLLECTIONS singletons. */
import { describe, expect, it } from "vitest"
import { parseMonitorCollections } from "../src/watched"

describe("parseMonitorCollections — edge collections", () => {
    it("refuses app.bsky.graph.follow and app.bsky.graph.block entries", () => {
        for (const entry of ["app.bsky.graph.follow/self", "app.bsky.graph.block/self"]) {
            expect(() => parseMonitorCollections(entry)).toThrow(`"${entry}"`)
            expect(() => parseMonitorCollections(`app.bsky.actor.profile/self,${entry}`)).toThrow(
                `"${entry}"`
            )
        }
        expect(parseMonitorCollections("app.bsky.graph.list/self")).toHaveLength(1)
    })
})
