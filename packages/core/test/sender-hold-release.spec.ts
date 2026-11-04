/**
 * `releaseHeld` and `sweepExpiredHolds`: what reaches a mailbox is decided by
 * the monitor's settled declaration alone. A held put is delivered only if
 * it verifies under the settled key, with the settled declaration as its
 * evidence; the interim key from the PDS never delivers anything.
 *
 * Harness: an in-memory `SenderHoldStorage` pre-loaded with held puts; a
 * settled declaration built as a signed CAR (as `direct-declaration.spec.ts`);
 * `AuthenticatedPutDeps` from the fake in `authenticated-put.spec.ts`,
 * recording each ingest's put and evidence. Settle deferred work before asserting.
 */
import { describe, it } from "vitest"

describe("releasing held puts on a monitor settle", () => {
    it.todo("a held put that verifies under the settled key is ingested with the settled CID, rev, CAR and anchor key as evidence")
    it.todo("released puts are ingested in arrival order and removed from the hold")
    it.todo("the envelope nonce is the replay key, so a put the sender also retried after settle is stored once")
    it.todo("released evidence expires messageExpirySeconds after the release")
    it.todo("a held put that fails under a settled revision at least as new as the one it was held under is dropped")
    it.todo("a settle of an older revision than a put was held under keeps that put waiting")
    it.todo("a settled revision at least the interim's clears the interim declaration")
    it.todo("a held put signed for a recipient with no registration is dropped at release")
    it.todo("an ingest refused for a full reservation drops the held put")
    it.todo("a settle with null drops every held put and the interim declaration")
    it.todo("a settled CAR with no readable anchor key releases nothing and drops puts held under an older or equal revision")
    it.todo("a settled CAR whose commit names another DID, whose rev is not settled.rev, or whose record CID is not settled.cid releases and stores nothing")
    it.todo("a settle older than the stored settled revision releases and stores nothing")
    it.todo("a repeated settle of the same declaration after release changes nothing")
    it.todo("a settle reaching an empty hold still stores the settled declaration")
    it.todo("a settle with null clears the stored settled declaration")
    it.todo("after a null, a put verified by a direct read is held and released by the later re-interest settle")
    it.todo("release returns only after every deferred body write and delivery has settled")
    it.todo("a deferred task that rejects is logged, and the release still removes every processed put")
})

describe("expiring held puts", () => {
    it.todo("a sweep drops held puts past their expiry and keeps the rest")
    it.todo("a sweep drops an interim declaration older than SENDER_HOLD_TTL_SECONDS")
    it.todo("a sweep drops a stored settled declaration older than SENDER_HOLD_TTL_SECONDS")
    it.todo("a sweep returns the earliest remaining expiry, or null when nothing is held")
    it.todo("a release drops expired held puts without ingesting them")
})
