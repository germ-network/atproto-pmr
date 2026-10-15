/**
 * The relay applies a can-message verdict as an admission: blocks become relay
 * blocks, refusals and undecided verdicts keep their reasons for the pool, and
 * a policy the relay does not yet honour admits nobody.
 */
import { describe, expect, it } from "vitest"
import { admissionOf, POLICY_NOT_ENABLED, RECIPIENT_NOT_HELD } from "../src/admission"

describe("admissionOf", () => {
    it("maps a no naming blocked to blocked", () => {
        expect(admissionOf({ verdict: "no", why: ["blocked"] })).toEqual({ verdict: "blocked" })
        expect(admissionOf({ verdict: "no", why: ["not-admitted", "blocked"] })).toEqual({ verdict: "blocked" })
    })

    it("maps any other no to no with its why", () => {
        expect(admissionOf({ verdict: "no", why: ["not-admitted"] })).toEqual({
            verdict: "no",
            why: ["not-admitted"],
        })
        expect(admissionOf({ verdict: "no", why: ["no-declaration"] })).toEqual({
            verdict: "no",
            why: ["no-declaration"],
        })
    })

    it("maps unknown to unknown with its why", () => {
        expect(
            admissionOf({ verdict: "unknown", pending: ["bsky-follows"], why: ["graph-incomplete", "block-unknown"] })
        ).toEqual({ verdict: "unknown", why: ["graph-incomplete", "block-unknown"] })
    })

    it("maps null to unknown recipient-not-held", () => {
        expect(admissionOf(null)).toEqual({ verdict: "unknown", why: [RECIPIENT_NOT_HELD] })
    })

    it("maps a yes via open alone to unknown policy-not-enabled", () => {
        expect(admissionOf({ verdict: "yes", via: ["open"] })).toEqual({
            verdict: "unknown",
            why: [POLICY_NOT_ENABLED],
        })
    })

    it("holds back a yes with no bounded policy, whatever it names", () => {
        expect(admissionOf({ verdict: "yes", via: [] })).toEqual({ verdict: "unknown", why: [POLICY_NOT_ENABLED] })
        expect(admissionOf({ verdict: "yes", via: ["some-new-policy"] })).toEqual({
            verdict: "unknown",
            why: [POLICY_NOT_ENABLED],
        })
    })

    it("maps a yes via bsky-follows (with or without open) to yes", () => {
        expect(admissionOf({ verdict: "yes", via: ["bsky-follows"] })).toEqual({ verdict: "yes" })
        expect(admissionOf({ verdict: "yes", via: ["open", "bsky-follows"] })).toEqual({ verdict: "yes" })
    })
})
