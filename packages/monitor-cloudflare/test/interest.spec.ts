/**
 * The allow list in the real Durable Object: who is in interest under each
 * policy, how registrations reach it, and what joining and leaving do to
 * everything kept for a DID.
 */
import { describe, it } from "vitest"

describe("interest set and policy", () => {
    it.todo("registered policy: a registered DID is in interest")
    it.todo("registered policy: a followee of a registered user is in interest; losing its last owner follower leaves")
    it.todo("everyone policy: held holders are in interest, gone ones are not")
    it.todo("join and leave transitions are reported once")
    it.todo("a non-holder followee is watched")
    it.todo("an owed-only never-held DID is watched under both policies")
    it.todo("a deleted DID in interest is not watched")
    it.todo("upgrade under everyone seeds interest from held holders")
    it.todo("upgrade under everyone marks gone-reversible holders' documents stale")
    it.todo("upgrade under registered leaves DIDs outside interest only after the first complete reconcile")
    it.todo("after upgrade under everyone, a PLC rotation for a held DID before the first alarm is followed")
    it.todo("under registered, a DID with a revs or records row stays watched until its leave is applied")
    it.todo("a holder discovered under everyone keeps its stored document")
})

describe("registration RPC and reconcile", () => {
    it.todo("register marks the DID registered and in interest")
    it.todo("unregister clears registered; the DID leaves interest unless still followed by an owner")
    it.todo("reconcile adds a registration the RPC missed and removes a stale one")
    it.todo("unregister followed by register within the grace disposes nothing")
    it.todo("reconcile does not remove a DID registered after the listing began")
    it.todo("reconcile does not remove a DID registered just before the listing")
    it.todo("reconcile does not re-add a just-unregistered DID")
    it.todo("registered policy without pmrDirectory fails at startup")
    it.todo("a reconcile that has never run runs on the first alarm")
    it.todo("a failing reconcile does not stop the settles behind it")
})

describe("joining and leaving interest", () => {
    it.todo("joining owes declaration and secondaries")
    it.todo("leaving disposes all snapshots without a push")
    it.todo("a secondary settle for a DID not in interest stores nothing")
    it.todo("a declaration deletion keeps the profile of a DID still in interest")
    it.todo("leaving withdraws the stored DID document")
    it.todo("a fetch in flight across a leave stores nothing")
    it.todo("a non-holder's join settle is quiet")
    it.todo("a holder's join settle is quiet unless a real commit coalesced into it")
    it.todo("leaving under registered drops the deleted row so the document stops being followed")
    it.todo("a reactivation owed between a gone settle and its leave is still settled (everyone)")
    it.todo("a join settle that finds the declaration gone records gone-reversible without a window entry or onDelete")
    it.todo("a leave then a join before the alarm disposes nothing")
    it.todo("a quiet join settle with a permanent not-found writes deleted with no push")
})

describe("head checks follow interest", () => {
    it.todo("a non-holder followee's profile is head-checked")
    it.todo("a non-holder is due once per REFRESH_NONHOLDER_STALE_AFTER_MS, a holder once per REFRESH_STALE_AFTER_MS")
    it.todo("a reversibly gone holder stays due for refresh under everyone")
    it.todo("a failing non-holder is retried once per its own daily bound")
    it.todo("a reversibly gone non-holder keeps the daily cadence")
})

describe("declaration intake by policy", () => {
    it.todo("registered policy ignores declaration commits outside interest")
    it.todo("registered policy skips the relay backfill")
    it.todo("everyone policy discovers new holders")
    it.todo("ignored declaration events advance the persisted cursor at most once per interval, never lowering it")
})
