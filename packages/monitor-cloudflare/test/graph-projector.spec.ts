/**
 * The ingest object keeps the projector's cursor and answers servedness from
 * the standing it last mirrored, and the alarm runs the projector after the
 * mirror.
 */
import { describe, it } from "vitest"

describe("MonitorIngest graph projector", () => {
    it.todo("the projector cursor round-trips through storage, null when never set")
    it.todo("mirroredGraphStanding follows graph_mirrored (owner, inflight), not the live standing")
    it.todo("servedGraphsMirrored pages mirrored owners and in-flight rows by DID")
    it.todo("a served-add whose markMirrored failed is projected on a later alarm")
    it.todo("an alarm after a served-add projects the owner's graph into graph:<did>")
    it.todo("an alarm after a served-remove deletes graph:<did>")
    it.todo("a projector failure does not stop the later graph steps or the re-arm")
})
