/**
 * `handlePairPut` with a sender hold wired in: a sender that just published a
 * new declaration gets `202` while the monitor catches up, and the decision
 * still reveals nothing about the recipient.
 *
 * Harness: the `world` fake in `pair-put.spec.ts`, plus a `senderHold` fake
 * recording its `HoldRequest`s and answering a scripted `HoldAdmission`, and
 * a scripted `unsnapshottedHoldBudget`.
 */
import { describe, it } from "vitest"

describe("pair put with a sender hold", () => {
    it.todo("a signature failure under the snapshot consults the hold with the received envelope bytes and the snapshot revision")
    it.todo("with no snapshot held, the hold is consulted with a null snapshot revision once the budget allows")
    it.todo("with no snapshot held and the budget spent, the answer is 409 without consulting the hold")
    it.todo("with no snapshot held and no budget wired, the answer is 409 without consulting the hold")
    it.todo("hold settled continues as a verified put under the returned declaration: stored with its CID, rev and CAR as evidence")
    it.todo("hold settled with a put signed for another recipient answers 202 and stores nothing")
    it.todo("hold accepted answers 202 and stores nothing in any mailbox")
    it.todo("hold unverifiable answers 409 with Retry-After DECLARATION_RETRY_AFTER_SECONDS")
    it.todo("hold full answers 429 with Retry-After relative to now")
    it.todo("the hold is decided before the directory is consulted: no recipient lookup on accepted, full or unverifiable")
    it.todo("a put that verifies under the snapshot never consults the hold")
    it.todo("a malformed or oversized envelope never consults the hold")
    it.todo("without senderHold a signature failure still answers 409")
})
