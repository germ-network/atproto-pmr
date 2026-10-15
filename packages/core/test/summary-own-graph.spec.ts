/** The summary chooses its contacts from the owner's private graph source, not a public projection. */
import { describe, it } from "vitest"

describe("summary contacts from ownGraph", () => {
    it.todo("covers the owner, then mutuals, following and followers from deps.graph.ownGraph")
    it.todo("answers 409 + Retry-After when the owner's graph is not served (graph.ownGraph null)")
    it.todo("answers 503 + Retry-After and leaves the stored baseline untouched when graph.ownGraph throws")
    // A gated fake: ownGraph resolves only after ownBlocks was called, so a sequential build hangs.
    it.todo("reads the graph and the owner's blocks concurrently")
})
