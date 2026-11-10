/**
 * `summaryOwnersAffected` over the D1 graph: who a change reaches, and that
 * only graph owners are returned.
 */
import { describe, it } from "vitest"

describe("summaryOwnersAffected", () => {
    it.todo("a changed DID reaches the owners who follow it")
    it.todo("a changed DID reaches the owners it follows")
    it.todo("a changed DID that is itself an owner is included")
    it.todo("a DID not in graph_owners is never returned, whether reached or named in owners")
    it.todo("owners are returned as named, without expanding to their followers or follows")
    it.todo("more DIDs than one statement binds are all covered, deduplicated and sorted")
    it.todo("an empty change returns no owners")
})
