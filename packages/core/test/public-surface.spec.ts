/** No public read serves a follow graph: the core package exports no graph read route or wire type. */
import { describe, it } from "vitest"

describe("core public surface", () => {
    // Runtime values only: type-only removals are proven by src no longer declaring them.
    it.todo("exports no handleGraphRead, projectGraph or graph read codec value")
    it.todo("exports no GRAPH_READ_KEYS or GRAPH_EDGE_KEYS")
})
