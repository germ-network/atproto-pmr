/**
 * The `#summary` graph-change hint: sent only to attached sockets, never
 * thrown, coalesced, and never part of the connect-time backlog.
 */
import { describe, it } from "vitest"

describe("nudgeSummary", () => {
    it.todo("sends nothing and resolves with no socket attached")
    it.todo("sends one #summary frame to each attached socket")
    it.todo("a socket whose send() throws neither escapes nor stops the others receiving it")
    it.todo("nudges inside the interval coalesce into one trailing frame")
    it.todo("a socket that connects after a nudge sees no #summary in its backlog")
})
