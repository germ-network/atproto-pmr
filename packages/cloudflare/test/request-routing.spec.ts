/**
 * Every non-blocked pair put is judged by admission on its own: a yes goes
 * to the sender's pair mailbox, anything else to its request mailbox. A
 * relay with no admission source admits nobody.
 */
import { describe, it } from "vitest"

describe("PMRObject.receive routing", () => {
    it.todo("holds a no or unknown put in the request mailbox")
    it.todo("holds a no put in the request mailbox even when the sender has a pair mailbox")
    it.todo("judges a put to a pair mailbox opened before this release like any other")
    it.todo("opens the pair mailbox on yes and moves request entries in ahead of the put, oldest first")
    it.todo("moves only as many request entries as the pair mailbox has room for, leaving the rest held")
    it.todo("a moved entry keeps its id, body and fields")
    it.todo("refuses a yes whose own ref does not fit, moving nothing")
    it.todo("never writes an admitted mark")
    it.todo("a sender whose request mailbox emptied is judged by admission again on its next put")
})

describe("PMRObject.appendPair without admission", () => {
    it.todo("holds a sender with no pair mailbox in the request mailbox")
    it.todo("appends to a pair mailbox an earlier admission opened")
})
