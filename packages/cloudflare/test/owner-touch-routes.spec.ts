/**
 * Which traffic records owner activity (D-24) and which never does.
 */
import { describe, it } from "vitest"

describe("auth site", () => {
    it.todo("authenticateOwner against a real PMRObject touches it")
})

describe("socket", () => {
    it.todo("a bare DO upgrade does not touch")
    it.todo("upgrade binds the current anchorKey; no registration → no binding")
    it.todo("an inbound frame (valid ack, malformed binary, string) touches via the bound key")
    it.todo("the bound key survives hibernation")
    it.todo("a frame whose bound key no longer matches does not touch")
    it.todo("a failing touch still processes the ack")
    it.todo("a failed key bind (e.g. oversized attachment) still completes the upgrade, unbound")
})

describe("never touches", () => {
    it.todo("server sends: deliverLive, backlog drain, capabilities, summary nudge")
    it.todo("deliverPush, including the 404/410 subscription discard")
    it.todo("alarm sweeps")
    it.todo("monitor recheck and declaration-watch writes")
    it.todo("pair put and grant put")
    it.todo("census probe")
})
