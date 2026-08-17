/**
 * The enabler document: what a host serving private messaging says it can
 * do, and where.
 *
 * Generated from the enforcing config rather than written beside it. A
 * published value and an enforced one that disagree are worse than an
 * unpublished value, and now that the document carries path prefixes, a
 * wrong one is a client that cannot route at all.
 */
import { describe, expect, it } from "vitest"
import {
    buildEnablerDocument,
    parseGrantLifecycle,
    parseVapidPublicKey,
    type PMRConfig,
} from "../src/config"

/** A real uncompressed P-256 point, so the vectors are not merely shaped right. */
const VAPID_KEY =
    "BIPu0Xl58BSDv_BWNq6VB_Riag7dd4VrHv6zbc_bFD1H6PAM4KlD85f4G__Rztpsh-HR0h6hDYS3pJ9LCtKTlxY"

function config(overrides: Partial<PMRConfig> = {}): PMRConfig {
    return {
        hostName: "relay.example",
        serves: {
            pathPrefix: "/pmr/v1",
            versions: ["1"],
            didMailbox: true,
            grant: true,
        },
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

describe("parseVapidPublicKey", () => {
    it("accepts an uncompressed P-256 point and hands it back unchanged", () => {
        // Returned rather than reshaped: the client passes exactly these
        // characters to its push service as the applicationServerKey.
        expect(parseVapidPublicKey(VAPID_KEY)).toBe(VAPID_KEY)
    })

    it("rejects standard base64, which decodes but is the wrong alphabet", () => {
        // The trap this catches: "+"/"/" decode to different bytes under
        // base64url, so a key pasted from a standard-base64 tool would be
        // published as a valid-looking key for a different point entirely.
        const standard = VAPID_KEY.replace(/-/g, "+").replace(/_/g, "/") + "="
        expect(() => parseVapidPublicKey(standard)).toThrow(/base64url and unpadded/)
    })

    it("rejects a compressed point, which is the same key in the wrong encoding", () => {
        // 33 bytes, 0x02-prefixed. Valid P-256, useless as an
        // applicationServerKey, and the mistake a P-256 export invites.
        expect(() =>
            parseVapidPublicKey("AoPu0Xl58BSDv_BWNq6VB_Riag7dd4VrHv6zbc_bFD1H")
        ).toThrow(/65-byte uncompressed P-256 point; got 33 bytes/)
    })

    it("names the prefix it found when the length is right but the form is not", () => {
        const bytes = new Uint8Array(65)
        bytes[0] = 0x03
        const wrongPrefix = Buffer.from(bytes).toString("base64url")
        expect(() => parseVapidPublicKey(wrongPrefix)).toThrow(/got 0x03/)
    })

    it("rejects a string that is not base64 at all, rather than throwing raw", () => {
        // atob's own DOMException says nothing about VAPID; an operator
        // reading a boot log should not have to guess which var it meant.
        expect(() => parseVapidPublicKey("not a key!!")).toThrow(
            /VAPID public key/
        )
    })
})

describe("buildEnablerDocument", () => {
    it("always carries core, so the always-served surface is discoverable", () => {
        // Registrations, challenges, and the events socket are served
        // whatever else is. Without this entry, POST /pmr/v1/challenges
        // would be the one path a client could not find.
        const core = buildEnablerDocument(config()).capabilities.core
        expect(core.pathPrefix).toBe("/pmr/v1")
        expect(core.versions).toEqual(["1"])
        expect(core.challengeExpiry).toBe(600)
    })

    it("gives every capability its own versions and prefix", () => {
        const caps = buildEnablerDocument(config()).capabilities
        for (const entry of [caps.core, caps.didMailbox!, caps.grant!]) {
            expect(entry.versions).toEqual(["1"])
            expect(entry.pathPrefix).toBe("/pmr/v1")
        }
    })

    it("lets the two mailbox kinds share one prefix", () => {
        // They differ in the key they accept, not in where they live, and
        // saying so is informative rather than redundant.
        const caps = buildEnablerDocument(config()).capabilities
        expect(caps.didMailbox!.pathPrefix).toBe(caps.grant!.pathPrefix)
    })

    it("OMITS a capability that is not served, rather than flagging it", () => {
        // A client tests for the key. A present-but-disabled entry would
        // make "serves grants" a two-step question and invite the reading
        // where a missing field means yes.
        const doc = buildEnablerDocument(
            config({
                serves: {
                    pathPrefix: "/pmr/v1",
                    versions: ["1"],
                    didMailbox: false,
                    grant: true,
                },
            })
        )
        expect("didMailbox" in doc.capabilities).toBe(false)
        expect(doc.capabilities.grant).toBeDefined()
    })

    it("serves grants alone — the case the split exists to allow", () => {
        // A free atproto PDS vending grant mailboxes and no DID mailbox.
        const doc = buildEnablerDocument(
            config({
                serves: {
                    pathPrefix: "/pmr/v1",
                    versions: ["1"],
                    didMailbox: false,
                    grant: true,
                },
            })
        )
        expect(Object.keys(doc.capabilities).sort()).toEqual(["core", "grant"])
    })

    it("nests the grant lifecycle under grant, where it applies", () => {
        const doc = buildEnablerDocument(config({ grantLifecycle: "draining" }))
        expect(doc.capabilities.grant!.lifecycle).toBe("draining")
        expect("lifecycle" in doc.capabilities.core).toBe(false)
    })

    it("carries a monitor capability at its own prefix when declared", () => {
        // The monitor can live somewhere else entirely — it is a separate
        // component, and this is how a client is told where.
        const doc = buildEnablerDocument(
            config({
                serves: {
                    pathPrefix: "/pmr/v1",
                    versions: ["1"],
                    didMailbox: true,
                    grant: true,
                    monitor: { pathPrefix: "/monitor/v1", versions: ["1"] },
                },
            })
        )
        expect(doc.capabilities.monitor!.pathPrefix).toBe("/monitor/v1")
    })

    it("omits monitor by default", () => {
        expect("monitor" in buildEnablerDocument(config()).capabilities).toBe(false)
    })

    it("publishes limits the put path actually enforces, not a copy", () => {
        const c = config()
        const caps = buildEnablerDocument(c).capabilities
        expect(caps.didMailbox!.messageMaxBytes).toBe(c.limits.messageMaxBytes)
        expect(caps.core.challengeExpiry).toBe(c.limits.challengeExpirySeconds)
        expect(caps.grant!.maxPerRequest).toBe(c.limits.maxGrantsPerRequest)
    })

    it("moves state when a config-only change moves the document", () => {
        // The failure this pins: lifecycle, size caps, and expiries all come
        // from deployment config an operator edits without touching source.
        // A hand-bumped state would sit still across exactly those deploys,
        // and a client polling it would miss the transition it polls for.
        const base = buildEnablerDocument(config()).state
        const drained = buildEnablerDocument(
            config({ grantLifecycle: "draining" })
        ).state
        const smaller = buildEnablerDocument(
            config({ limits: { ...config().limits, messageMaxBytes: 9_000 } })
        ).state
        expect(drained).not.toBe(base)
        expect(smaller).not.toBe(base)
        expect(drained).not.toBe(smaller)
    })

    it("holds state still when nothing changed", () => {
        expect(buildEnablerDocument(config()).state).toBe(
            buildEnablerDocument(config()).state
        )
    })

    it("keeps the operator's stamp readable at the front of state", () => {
        // So a served document still says which release it came from.
        expect(buildEnablerDocument(config()).state).toMatch(
            /^2026-08-13\.1\.[0-9a-f]{8}$/
        )
    })

    it("publishes vapidKey on core, where a client about to register finds it", () => {
        // On core because registration is core's surface and the
        // subscription is carried at registration — and because one
        // deployment signs with one keypair, so a per-mailbox-kind key
        // would leave a client asking which one to bind to.
        const doc = buildEnablerDocument(config({ vapidPublicKey: VAPID_KEY }))
        expect(doc.capabilities.core.vapidKey).toBe(VAPID_KEY)
        expect("vapidKey" in doc.capabilities.didMailbox!).toBe(false)
        expect("vapidKey" in doc.capabilities.grant!).toBe(false)
    })

    it("OMITS vapidKey when the deployment delivers push itself", () => {
        // Same rule as an unserved capability: a client tests for the key.
        // Push delegation is optional, and a relay that reaches its own
        // push service must not look like one asking to be delivered to.
        expect("vapidKey" in buildEnablerDocument(config()).capabilities.core).toBe(
            false
        )
    })

    it("moves state when the VAPID key is added or rotated", () => {
        // A client polls state to notice a change. A rotated key that left
        // state still would strand subscriptions bound to the old one for a
        // full cache lifetime, with nothing to signal the rotation.
        const base = buildEnablerDocument(config()).state
        const keyed = buildEnablerDocument(config({ vapidPublicKey: VAPID_KEY })).state
        const rotated = buildEnablerDocument(
            config({ vapidPublicKey: VAPID_KEY.replace(/^BIPu/, "BIPv") })
        ).state
        expect(keyed).not.toBe(base)
        expect(rotated).not.toBe(keyed)
    })

    it("publishes nothing about pool sizing or blocked-sender behavior", () => {
        // The first is implementation-defined; the second is unpublished on
        // purpose, since a published simulation is a fingerprint.
        const serialized = JSON.stringify(buildEnablerDocument(config()))
        expect(serialized).not.toContain("pool")
        expect(serialized).not.toContain("synthetic")
    })
})
