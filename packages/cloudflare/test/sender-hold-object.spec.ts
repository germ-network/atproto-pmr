/**
 * `SenderHoldObject` and its adapters: the hold survives eviction, expires on
 * its own alarm, serializes a sender's PDS reads, and releases through the
 * same mailbox store a pair put uses.
 *
 * Harness: the `SENDER_HOLDS` binding (`TestSenderHold` in `test/worker.ts`),
 * scripted with `setDirect`; recipients registered as in `admitted-mailbox.spec.ts`;
 * `runInDurableObject` to read storage and fire `alarm()` directly. Envelopes
 * and settled CARs as in core's `sender-hold-release.spec.ts`.
 */
import { describe, it } from "vitest"

describe("sender hold object", () => {
    it.todo("a held put and the interim declaration survive the object being evicted and rebuilt")
    it.todo("holding a put arms an alarm at its expiry")
    it.todo("the alarm drops expired holds and re-arms for the earliest remaining expiry, or clears with none")
    it.todo("two concurrent admits for one sender with no interim key read the PDS once, and both are held")
    it.todo("a call naming a different sender DID than the object's first is refused")
    it.todo("the default cap is MAX_MESSAGES_PER_PAIR_SENDER")
    it.todo("settle releases a verifying held put into the recipient's pair mailbox and its body into the body store")
    it.todo("settle with null empties the hold and clears the alarm")
    it.todo("a settle reaching an empty object stores it and arms the sweep, which later leaves the object empty")
})

describe("sender hold adapters", () => {
    it.todo("senderHolds is undefined when SENDER_HOLDS is not bound")
    it.todo("senderHolds addresses one object per sender DID, so two senders' holds are independent")
    it.todo("releaseSenderHold forwards the settle to that sender's object")
    it.todo("releaseSenderHold swallows a hold fault and does nothing when SENDER_HOLDS is not bound")
})
