/**
 * The own-DID declaration watch's pure decision logic (`watch.ts`): classify a
 * re-check against the trusted key, and fold the outcome into `WatchState`.
 *
 * The load-bearing properties pinned here:
 *  - a resolved-but-different key pauses (rotation is not silently accepted;
 *    GER-2212 owns proper rotation, and pausing is the interim cover);
 *  - a CONFIRMED absence pauses, an UNCONFIRMED (transient) failure does not —
 *    a PDS blip must never pause a healthy mailbox;
 *  - `unknown` moves the paused flag in neither direction.
 */
import { describe, expect, it } from "vitest"
import {
    INITIAL_WATCH_STATE,
    classifyDeclaration,
    reconcileWatchState,
    type WatchState,
} from "../src/watch"
import type { DeclarationResolution } from "../src/declaration"

const TRUSTED = new Uint8Array(32).map((_, i) => i)
const DIFFERENT = new Uint8Array(32).fill(0xaa)

const present = (x: Uint8Array): DeclarationResolution => ({
    found: true,
    anchorKey: { x },
})
const confirmedGone: DeclarationResolution = {
    found: false,
    reason: "gone",
    confirmed: true,
}
const transient: DeclarationResolution = {
    found: false,
    reason: "unreachable",
    confirmed: false,
}
const transientImplicit = { found: false, reason: "unreachable" } as DeclarationResolution

describe("classifyDeclaration", () => {
    it("present when the declared key equals the trusted key", () => {
        expect(classifyDeclaration(present(TRUSTED), TRUSTED)).toBe("present")
    })

    it("absent when the declared key differs — a rotation, pause is the interim cover", () => {
        expect(classifyDeclaration(present(DIFFERENT), TRUSTED)).toBe("absent")
    })

    it("absent on a confirmed disappearance", () => {
        expect(classifyDeclaration(confirmedGone, TRUSTED)).toBe("absent")
    })

    it("unknown on a transient failure (confirmed:false)", () => {
        expect(classifyDeclaration(transient, TRUSTED)).toBe("unknown")
    })

    it("unknown on a transient failure with confirmed absent", () => {
        expect(classifyDeclaration(transientImplicit, TRUSTED)).toBe("unknown")
    })

    it("compares the full key, not a prefix — a one-byte difference is absent", () => {
        const almost = TRUSTED.slice()
        almost[31] ^= 0x01
        expect(classifyDeclaration(present(almost), TRUSTED)).toBe("absent")
    })
})

describe("reconcileWatchState", () => {
    const paused: WatchState = { paused: true, lastCheckAt: 1 }
    const live: WatchState = { paused: false, lastCheckAt: 1 }

    it("present unpauses and stamps", () => {
        expect(reconcileWatchState(paused, "present", 100)).toEqual({
            paused: false,
            lastCheckAt: 100,
        })
    })

    it("absent pauses and stamps", () => {
        expect(reconcileWatchState(live, "absent", 100)).toEqual({
            paused: true,
            lastCheckAt: 100,
        })
    })

    it("unknown leaves a live mailbox live (never pauses on a blip)", () => {
        expect(reconcileWatchState(live, "unknown", 100)).toEqual({
            paused: false,
            lastCheckAt: 100,
        })
    })

    it("unknown leaves a paused mailbox paused (recovery needs a confirmed present)", () => {
        expect(reconcileWatchState(paused, "unknown", 100)).toEqual({
            paused: true,
            lastCheckAt: 100,
        })
    })

    it("INITIAL_WATCH_STATE is live and never-checked", () => {
        expect(INITIAL_WATCH_STATE).toEqual({ paused: false, lastCheckAt: 0 })
    })
})

/**
 * The monotonic-rev watermark (`spec/storage-consistency.md`'s "last observed
 * declaration revision"; `spec/trust-model.md`'s monotonic-rev tracking). A
 * `present`/`absent` outcome is applied only when its observed rev is strictly
 * newer than the stored one; a reordered/replayed recheck (Cloudflare Queues are
 * unordered + at-least-once) or a rev that moved backwards (a rollback) is
 * refused — the flag holds, only the check is stamped. The DECISION is the
 * outcome (a value comparison); the rev is only for ordering and direction.
 */
describe("reconcileWatchState — monotonic-rev watermark", () => {
    const live: WatchState = { paused: false, lastCheckAt: 1, lastObservedRev: "3m5" }
    const paused: WatchState = { paused: true, lastCheckAt: 1, lastObservedRev: "3m5" }

    it("a newer rev applies and advances the watermark (absent → pause)", () => {
        expect(reconcileWatchState(live, "absent", 100, "3m6")).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m6",
        })
    })

    it("a newer rev applies and advances the watermark (present → unpause)", () => {
        expect(reconcileWatchState(paused, "present", 100, "3m6")).toEqual({
            paused: false,
            lastCheckAt: 100,
            lastObservedRev: "3m6",
        })
    })

    it("an EQUAL rev is refused — a duplicate redelivery cannot move the flag", () => {
        // present at the same rev must NOT unpause a mailbox paused from that rev.
        expect(reconcileWatchState(paused, "present", 100, "3m5")).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m5",
        })
    })

    it("an OLDER rev is refused — a reordered/replayed stale wake cannot unpause", () => {
        expect(reconcileWatchState(paused, "present", 100, "3m4")).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m5",
        })
    })

    it("a regressed rev is refused for a pause too (a rollback is not accepted)", () => {
        expect(reconcileWatchState(live, "absent", 100, "3m4")).toEqual({
            paused: false,
            lastCheckAt: 100,
            lastObservedRev: "3m5",
        })
    })

    it("the first rev observed (no prior floor) always advances", () => {
        const neverChecked: WatchState = { paused: false, lastCheckAt: 0 }
        expect(reconcileWatchState(neverChecked, "absent", 100, "3m1")).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m1",
        })
    })

    it("unknown stamps only and never advances the watermark, whatever the rev", () => {
        expect(reconcileWatchState(paused, "unknown", 100, "3m9")).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m5",
        })
    })

    it("a rev-less apply is NOT watermark-gated (a fully-gone repo pauses, fail-safe) and does not advance", () => {
        expect(reconcileWatchState(live, "absent", 100)).toEqual({
            paused: true,
            lastCheckAt: 100,
            lastObservedRev: "3m5",
        })
    })

    it("a rev-less apply on a never-observed state carries no rev key", () => {
        const neverChecked: WatchState = { paused: false, lastCheckAt: 0 }
        expect(reconcileWatchState(neverChecked, "absent", 100)).toEqual({
            paused: true,
            lastCheckAt: 100,
        })
    })
})
