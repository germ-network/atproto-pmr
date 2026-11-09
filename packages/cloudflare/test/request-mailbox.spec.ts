/**
 * A request mailbox holds puts from a sender admission did not admit. It
 * refuses when the sender's own depth is full, keeps nothing more once the
 * recipient's shared byte quota is full, and exists only while it holds an
 * entry.
 */
import { describe, it } from "vitest"

describe("PMRObject.appendToRequest", () => {
    it.todo("holds a put in the sender's request mailbox and records its nonce")
    it.todo("answers a repeated nonce duplicate and writes nothing")
    it.todo("refuses past the sender's depth with the shared retry instant, keeping the oldest entries")
    it.todo("records no nonce on a refusal, so a retry is judged afresh once there is room")
    it.todo("drops a put whose bytes do not fit the shared quota, keeping nothing and recording no nonce")
    it.todo("checks the sender's depth before the shared quota")
    it.todo("charges each held entry's bytes to the shared quota")
    it.todo("takes the same storage round trips for a dropped put as for a held one")
})

describe("request entries under the sender's key", () => {
    it.todo("getMessage finds a request entry by sender DID and id")
    it.todo("getMessage misses identically for an acked request entry, an unknown id and an absent sender")
    it.todo("getMessage and remove reach both tiers when one sender holds pair and request entries")
    it.todo("never holds one message id in both tiers")
    it.todo("remove applies the same pair-generation rule to a request entry as to a pair entry")
    it.todo("remove deletes a request entry idempotently and refunds its bytes")
    it.todo("removing the last request entry leaves no request mailbox key")
    it.todo("request entries never appear in openMailboxes or list, and do not make hasMailbox true")
    it.todo("a request-only sender with a proof row yields no openMailboxes descriptor")
})

describe("PMRObject.requestMailboxes", () => {
    it.todo("lists each request mailbox's DID with its entry ids oldest first, in key order")
    it.todo("pages by limit and resumes from nextCursor, ending with null")
    it.todo("lists nothing for a recipient with no request entries")
})
