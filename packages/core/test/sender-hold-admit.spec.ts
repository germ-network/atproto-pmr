/**
 * `admitToHold`: a put that failed under the monitor's snapshot is delivered
 * under a declaration the monitor has already settled, or held exactly when
 * it verifies under a declaration the sender's PDS shows newer than both the
 * snapshot and the last settle; the PDS is read at most once per memo window.
 *
 * Harness: an in-memory `SenderHoldStorage`; `readDirect` a counting fake
 * scripted per test, coalescing concurrent calls as the contract requires;
 * envelopes from `encodePairPutEnvelope` signed with an old key A (the
 * snapshot's) and a new key B (the PDS's). Revisions are TIDs.
 */
import { describe, it } from "vitest"

describe("verifying a put the snapshot could not", () => {
    it.todo("a put that verifies under a stored settled declaration newer than the snapshot answers settled with that declaration, without a PDS read")
    it.todo("a stored settled declaration no newer than the snapshot revision is not used")
    it.todo("after a settle reached an empty hold, a put failing under an older snapshot answers settled and is not held")
    it.todo("a put signed by the PDS-declared key, newer than the snapshot, is held and accepted")
    it.todo("a put verified by a fresh read caches that declaration as the interim key")
    it.todo("a later put verified by the cached interim key is held without another PDS read")
    it.todo("a put that fails under the interim key reads the PDS again only after DIRECT_READ_MEMO_SECONDS from the last completed read")
    it.todo("inside the memo window a put no interim key verifies is unverifiable without a PDS read")
    it.todo("a put issued while another's read is in flight shares that read, and both are held")
    it.todo("a PDS declaration no newer than the snapshot revision is unverifiable and not cached")
    it.todo("a PDS declaration no newer than the stored settled revision is unverifiable and not cached")
    it.todo("with no snapshot held, a verified PDS declaration admits the put")
    it.todo("a put that fails under the PDS-declared key is unverifiable, and that newer declaration is still cached")
    it.todo("a PDS read that is found: false is unverifiable")
    it.todo("an interim key older than SENDER_HOLD_TTL_SECONDS is not used")
    it.todo("a put signed for another recipient under the interim key is accepted and not held")
})

describe("holding a verified put", () => {
    it.todo("a repeat of a held nonce is accepted and held once, even when the hold is full")
    it.todo("at maxHeld held puts the next verified put is full, retryAfter the earliest held expiry")
    it.todo("two puts verified by one coalesced read cannot together exceed maxHeld: the cap is checked after the read resolves")
    it.todo("an unverifiable put against a full hold is unverifiable, not full")
    it.todo("a held put expires SENDER_HOLD_TTL_SECONDS after it was held and records the revision it verified under")
})

describe("per-minute budget", () => {
    it.todo("perMinuteBudget allows that many spends in a minute, refuses the next, and refills the next minute")
})
