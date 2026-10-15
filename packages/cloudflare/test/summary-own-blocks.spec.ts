/** The owner's own blocks through the relay: the RPC adapter and the stored summary baseline. */
import { describe, it } from "vitest"

describe("monitorOwnBlocks", () => {
    it.todo("forwards to the ingest object's ownBlocks")
    it.todo("throws when no monitor is bound or the call fails")
})

describe("summary read — own blocks", () => {
    it.todo("a stored baseline holds the owner's blocks, so an unchanged list reads back as b null")
    it.todo("a change to blocks alone issues a new token")
    it.todo("answers 503 when the owner's blocks cannot be read, keeping the held baseline")
    it.todo("answers 409 when the owner's graph is not served, keeping the held baseline")
})
