/**
 * Request mailboxes never wake the device: the connect-time backlog is
 * capabilities, queued messages, then caught-up, with nothing about them.
 */
import { describe, it } from "vitest"

describe("drainBacklog", () => {
    it.todo("sends #capabilities, every queued delivery, then #caughtUp and no other frame")
    it.todo("does not read request mailboxes")
})
