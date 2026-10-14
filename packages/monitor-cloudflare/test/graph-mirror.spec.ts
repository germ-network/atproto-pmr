/**
 * The edge index's copy of who is served, who holds a declaration and who is
 * in interest, pushed from the single writer's state by the alarm.
 */
import { describe, it } from "vitest"

describe("graph mirror", () => {
    it.todo("an owner whose first listing has not completed is not served")
    it.todo("a removed owner is mirrored with served-remove and its owner rows pruned")
    it.todo("a DID leaving interest has its mutual-hint rows pruned")
    it.todo("a non-owner whose holder flag changes keeps its edges")
    it.todo("a mirror retried after its batch committed still prunes the removed owner")
    it.todo("a holder whose leave dropped its holder_state is mirrored as holder-remove")
    it.todo("reconcile repairs a missed add or remove")
    it.todo("change rows older than retention are pruned in bounded chunks")
    it.todo("a failing mirror step does not stop the re-arm")
    it.todo("a standing change during the mirror's batch is mirrored on the next alarm")
})
