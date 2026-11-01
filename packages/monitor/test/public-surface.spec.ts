/** The monitor runs no job that projects a follow graph for publication. */
import { describe, expect, it } from "vitest"
import * as monitor from "../src"

describe("monitor public surface", () => {
    it("exports no graph projector", () => {
        expect(monitor).not.toHaveProperty("runGraphProjector")
        expect(monitor).not.toHaveProperty("PROJECT_STATEMENTS_PER_DID")
    })
})
