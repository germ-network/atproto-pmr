/**
 * A request sender's proof counts against the shared request quota with its
 * entries: held together or not at all, served while its entries are held,
 * and gone with them.
 */
import { describe, it } from "vitest"

describe("request-sender pair evidence", () => {
    it.todo("holds a first-contact request entry and its proof when both fit the shared quota")
    it.todo("drops a first contact whose entry and proof do not fit, writing no evidence row")
    it.todo("charges only the entry bytes when the sender's live proof is already held")
    it.todo("binds held request refs to the pair generation and declaration hint")
    it.todo("getPairEvidence serves a request-only sender's proof")
    it.todo("removing a request-only sender's last entry deletes its evidence row and refunds the proof bytes")
    it.todo("proof expiry for a request-only sender deletes its entries and evidence row and refunds their bytes")
    it.todo("openMailboxes applies the same expiry purge to a request-only sender it meets")
    it.todo("moving every request entry on admission releases the proof from the shared quota")
    it.todo("emptying the request mailbox of a sender that also holds a pair mailbox keeps the proof and zeroes its request accounting, so a later clear refunds nothing twice")
    it.todo("a request entry held without evidence stays until acked, moved or blocked")
    it.todo("a sender key change recycles request entries with the pair entries")
})
