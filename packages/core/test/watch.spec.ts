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
