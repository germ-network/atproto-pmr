/**
 * The public graph projections follow the edge index's change log: every
 * served graph a row names is re-projected, an unserved one has its
 * projection deleted, and a projector that falls behind retention rebuilds.
 */
import { describe, it } from "vitest"

describe("runGraphProjector", () => {
    describe("tail", () => {
        it.todo("a row for a served graph writes its projection from the edge reads")
        it.todo("a DID named by several rows in one pass is projected once")
        it.todo("a row for a graph not served in the mirrored standing deletes its projection")
        it.todo("a DID whose mirrored standing is in flight stops the pass, cursor before it, and is not deleted")
        it.todo("a served-remove row deletes the projection")
        it.todo("the cursor advances to the last row whose write completed")
        it.todo("a failed write leaves the cursor before that row, so it is retried")
        it.todo("stops before a DID the statement budget cannot pay for, cursor before it")
        it.todo("no rows past the cursor changes nothing")
    })
    describe("rebuild", () => {
        it.todo("the first run, with no cursor, rebuilds as of the log's high-water mark")
        it.todo("a first row past cursor + 1 starts a rebuild")
        it.todo("project phase re-projects every mirrored served graph, paged across runs")
        it.todo("an in-flight DID in the project phase stops the pass without advancing the page")
        it.todo("sweep phase deletes every held projection not served, paged across runs")
        it.todo("after the sweep, tailing resumes from the rebuild's asOfSeq")
    })
})
