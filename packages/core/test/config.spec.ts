/**
 * Capability parsing and the capability document.
 *
 * The parsers exist so a deployment declares what it serves exactly once.
 * Two independent declarations can disagree, and the one a client happens
 * to read then decides what it believes — which is the drift the capability
 * document is generated (rather than written) to prevent.
 */
import { describe, expect, it } from "vitest"
import {
    buildCapabilityDocument,
    parseGrantLifecycle,
    parseServedFunctions,
    type PMRConfig,
} from "../src/config"

function config(overrides: Partial<PMRConfig> = {}): PMRConfig {
    return {
        hostName: "relay.example",
        functions: ["pairMailbox", "grant", "watch", "observation"],
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

describe("parseServedFunctions", () => {
    it("parses the four identifiers, trimming whitespace", () => {
        expect(parseServedFunctions("pairMailbox, grant , watch,observation")).toEqual(
            ["pairMailbox", "grant", "watch", "observation"]
        )
    })

    it("accepts a watch-only deployment", () => {
        expect(parseServedFunctions("watch")).toEqual(["watch"])
    })

    it("accepts grant standing alone — the case the split exists to allow", () => {
        expect(parseServedFunctions("grant")).toEqual(["grant"])
    })

    it("accepts an empty declaration", () => {
        // Serves nothing but the always-present surface. Odd, not invalid.
        expect(parseServedFunctions("")).toEqual([])
    })

    it("REJECTS an unrecognized identifier rather than dropping it", () => {
        // Silently ignoring "grants" would leave a deployment serving grant
        // mailboxes while telling every client it does not.
        expect(() => parseServedFunctions("pairMailbox,grants")).toThrow(
            /Unknown capability "grants"/
        )
    })

    it("rejects pairMailbox without grant", () => {
        expect(() => parseServedFunctions("pairMailbox")).toThrow(
            /MUST also serve grant/
        )
    })
})

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
    it("publishes the declared capabilities verbatim", () => {
        expect(buildCapabilityDocument(config()).functions).toEqual([
            "pairMailbox",
            "grant",
            "watch",
            "observation",
        ])
    })

    it("publishes the grant lifecycle when grants are served", () => {
        expect(
            buildCapabilityDocument(config({ grantLifecycle: "draining" }))
                .grantLifecycle
        ).toBe("draining")
    })

    it("omits the grant lifecycle when grants are not served", () => {
        // Meaningless without the capability it describes — absent rather
        // than reported as "absent", which a client could misread as a
        // drain that has finished.
        const doc = buildCapabilityDocument(config({ functions: ["watch"] }))
        expect(doc.grantLifecycle).toBeUndefined()
        expect("grantLifecycle" in doc).toBe(false)
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
