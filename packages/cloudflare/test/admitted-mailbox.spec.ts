/**
 * The store routes each adjudicated pair put in one step. A server-admitted
 * mailbox delivers like a provisioned one but is judged again on every put
 * until the device provisions the sender, which makes it a device contact.
 */
import { describe, it } from "vitest"

describe("PMRObject.receive", () => {
    it.todo("yes with nothing held opens a mailbox marked admitted and queues the ref")
    it.todo("yes moves the sender's pooled entries into the admitted queue ahead of the new ref, returns them as moved, and drops their verdict")
    it.todo("yes inside a live discard window still queues")
    it.todo("no or unknown with nothing held pools the ref with its verdict")
    it.todo("no or unknown inside a live discard window is dropped as pooled, persistBody false")
    it.todo("no or unknown from an admitted sender pools the ref and leaves its queue as it is")
    it.todo("a device-provisioned sender is queued whatever the verdict")
    it.todo("a device-blocked sender is absorbed synthetically whatever the verdict, as append's blocked path")
    it.todo("blocked mirrors a bsky block, clearing queue, pool and admitted mark, and absorbs the put synthetically")
    it.todo("yes lifts a bsky marker, then routes the put")
    it.todo("no or unknown (including admission-unavailable) leave a bsky marker in place and the put is absorbed synthetically")
    it.todo("blocked for a device-blocked sender writes no bsky marker")
    it.todo("a duplicate nonce or a paused registration writes nothing, including no block-marker transition")
    it.todo("a yes is refused only when the new ref does not fit, and that refusal writes no mailbox, mark or move")
    it.todo("a yes with more pooled entries than room moves the oldest that fit and leaves the rest pooled with their verdict")
    it.todo("an admitted mailbox at capacity is refused with the synthetic path's Retry-After source")
    it.todo("provisionFromPool clears the admitted mark, with or without pooled entries")
    it.todo("an admitted mailbox's messages drain and ack like a provisioned mailbox's")
})
