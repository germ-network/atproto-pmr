/**
 * Every storage effect of a put, a recycle or a read reaches only the
 * mailbox it was authorized for. Bodies here share one store across
 * registrations, as a KV-backed adapter does, so a body keyed by anything two
 * mailboxes can share would let one mailbox's recycle delete another's body.
 *
 * Harness: `ingestAuthenticatedPut` (reuse the fake in
 * `authenticated-put.spec.ts`) against a directory resolving each recipient DID
 * to its own locator, per-(locator, key) in-memory queues whose `appendPair`
 * recycles that mailbox's own refs when the anchor key changes, and ONE shared
 * `BodyStore` map. Settle every deferred task before asserting.
 */
import { describe, it } from "vitest"

describe("body storage stays within its mailbox", () => {
    it.todo(
        "an attacker's rotation in its own registration does not delete a victim's body holding the same bytes"
    )
    it.todo(
        "a stranger's rotation in the victim's pool does not delete the victim's queued body holding the same bytes"
    )
    it.todo(
        "a sender rotating in one recipient's registration keeps the identical bytes it queued for another recipient"
    )
    it.todo("the same bytes put to two grant mailboxes are stored under two ids")
})
