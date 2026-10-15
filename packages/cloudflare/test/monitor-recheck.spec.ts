/**
 * A device read of a lapsed declaration reaches the bound monitor as a
 * refresh request, and never fails the read when the monitor is absent or down.
 */
import { describe, it } from "vitest"

describe("monitorRecheck", () => {
    it.todo("forwards the DID and the request time to the ingest object's requestRefresh")
    it.todo("does nothing when no monitor is bound")
    it.todo("resolves, with a warning, when the monitor call throws")
})
