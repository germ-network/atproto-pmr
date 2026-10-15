/** The owner's own blocks in the authenticated summary, and nowhere public. */
import { describe, it } from "vitest"

describe("summary — own blocks", () => {
    it.todo("a full summary carries the owner's blocks under b")
    it.todo("a delta carries b as null when the owner's blocks are unchanged")
    it.todo("a delta carries the whole block list when any block was added or removed")
    it.todo("decodes a summary without b, as from a relay that predates it")
})
