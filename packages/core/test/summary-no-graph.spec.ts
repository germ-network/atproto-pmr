/** The owner's summary carries computed results only: no follow graph in the delta or its baseline. */
import { describe, it } from "vitest"

describe("summary without a graph", () => {
    it.todo("an encoded delta never carries the retired graph key \"g\"")
    it.todo("a summary index holds the owner, the owner's blocks and record entries, and no edges")
    it.todo("a follow change that leaves the covered records unchanged yields an unchanged delta")
    it.todo("a contact leaving the graph shows only as removal of its records")
})
