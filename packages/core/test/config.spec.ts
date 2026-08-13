/**
 * Grant-lifecycle parsing and the capability document.
 *
 * The parser exists so a deployment declares its grant state exactly once.
 * Two independent declarations can disagree, and the one a client happens
 * to read then decides what it believes — which is the drift the capability
 * document is generated (rather than written) to prevent.
 */
import { describe, expect, it } from "vitest"
import {
    buildCapabilityDocument,
    parseGrantLifecycle,
    type PMRConfig,
} from "../src/config"

function config(overrides: Partial<PMRConfig> = {}): PMRConfig {
    return {
        hostName: "relay.example",
        grantLifecycle: "active",
        configState: "2026-08-13.1",
        limits: {
            messageMaxBytes: 10_000,
            framingAllowanceBytes: 1024,
            messageExpirySeconds: 2_592_000,
            maxMessagesPerPairSender: 20,
            challengeExpirySeconds: 600,
            grantExpirySeconds: 2_592_000,
            maxGrantsPerRequest: 20,
        },
        pool: {
            capBytes: 5_000_000,
            depthPerSender: 2,
            depthUnderPressure: 1,
            discardWindowSeconds: 604_800,
        },
        ...overrides,
    }
}

describe("parseGrantLifecycle", () => {
    it("parses the three states", () => {
        expect(parseGrantLifecycle("active")).toBe("active")
        expect(parseGrantLifecycle("draining")).toBe("draining")
        expect(parseGrantLifecycle("absent")).toBe("absent")
    })

    it("rejects a typo rather than putting it on the wire", () => {
        expect(() => parseGrantLifecycle("drainin")).toThrow(
            /Unknown grant lifecycle "drainin"/
        )
    })
})

describe("buildCapabilityDocument", () => {
    it("publishes the grant lifecycle, always", () => {
        // Unconditional now that operating mailboxes is not a declared
        // capability: there is no configuration in which a relay serves no
        // grants, only one in which it has stopped vending new ones.
        for (const grantLifecycle of ["active", "draining", "absent"] as const) {
            expect(
                buildCapabilityDocument(config({ grantLifecycle }))
                    .grantLifecycle
            ).toBe(grantLifecycle)
        }
    })

    it("publishes no capability list", () => {
        // A relay operates both mailbox kinds or is not a relay, so there
        // is nothing for a client to switch on and nothing to drift.
        expect("functions" in buildCapabilityDocument(config())).toBe(false)
    })

    it("publishes limits the put path actually enforces, not a copy", () => {
        const c = config()
        const doc = buildCapabilityDocument(c)
        expect(doc.limits.messageMaxBytes).toBe(c.limits.messageMaxBytes)
        expect(doc.limits.challengeExpiry).toBe(c.limits.challengeExpirySeconds)
    })

    it("publishes nothing about pool sizing or blocked-sender behavior", () => {
        // The first is implementation-defined; the second is unpublished on
        // purpose, since a published simulation is a fingerprint.
        const doc = buildCapabilityDocument(config())
        const serialized = JSON.stringify(doc)
        expect(serialized).not.toContain("pool")
        expect(serialized).not.toContain("synthetic")
    })
})
