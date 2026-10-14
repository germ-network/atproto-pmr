/**
 * The stored DID document: rendering one from a PLC operation exactly as the
 * directory presents it, and the relay trusting a stored one only while it
 * is fresh.
 */
import { describe, expect, it } from "vitest"
import { renderPlcDocument } from "../src/did-document"

/**
 * Operations are the current heads of live did:plc identities and the
 * documents are what plc.directory served for them (verbatim).
 */
const P256_DID = "did:plc:phmkr5ww74rjxr2rokqsuasz"
const P256_OP = {
    sig: "suaTFgb_HheaZB_G5mFr4NYs7mrIKxdxQzq7262NlWFPQEUfDRQL0DyuStD6J8PGsv9kDXXfsL2namFoUh-PHw",
    prev: null,
    type: "plc_operation",
    services: {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.trump.com" },
    },
    alsoKnownAs: [
        "at://donald.trump.com",
        "at://jr.donald.trump.com",
        "at://eric.trump.com",
        "at://ivanka.trump.com",
        "at://tiffany.trump.com",
        "at://barron.trump.com",
        "at://melania.trump.com",
    ],
    rotationKeys: [
        "did:key:zDnaevrziR1WKG1ubkHibGAzxdYete4cEFTa93LQWAryhk5Lf",
        "did:key:zDnaevYkk2m4n71YScSLxC2auBK1UvGJcuWTW1vQ2PY2e7pRm",
        "did:key:zDnaepy3XJ6wjK3FZpgHRqFY4f4v7h2Jt5LXhPKwniDi3DKF3",
        "did:key:zDnaemg8EayDAXM4tUfkctEtQgKknCG3jP8n2X5x2MELdGinX",
    ],
    verificationMethods: { atproto: "did:key:zDnaem9MQgoc3UrwQCHzwo5QFbwMGGBFUYqvDG8Aj1D38fk1d" },
}
const P256_DOC = {
    "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1",
        "https://w3id.org/security/suites/ecdsa-2019/v1",
    ],
    id: P256_DID,
    alsoKnownAs: P256_OP.alsoKnownAs,
    verificationMethod: [
        {
            id: `${P256_DID}#atproto`,
            type: "Multikey",
            controller: P256_DID,
            publicKeyMultibase: "zDnaem9MQgoc3UrwQCHzwo5QFbwMGGBFUYqvDG8Aj1D38fk1d",
        },
    ],
    service: [
        {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://pds.trump.com",
        },
    ],
}

const K256_DID = "did:plc:6edp3jqlrjppzkprxzlt6ct3"
const K256_OP = {
    sig: "aUlO7jFK_WX2VGlMrDQSfndNS4CLdt_GnbJkq18uxKsZq0NT3-sSf-VtVegI8WPlMMPhIqg-DjbcYRt64ACs_g",
    prev: null,
    type: "plc_operation",
    services: {
        atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://phellinus.us-west.host.bsky.network",
        },
    },
    alsoKnownAs: ["at://natalieanderson97.bsky.social"],
    rotationKeys: [
        "did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg",
        "did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK",
    ],
    verificationMethods: { atproto: "did:key:zQ3shdrX5UZHPdAPDCvCCxGn8mktUByzn2ZrzA24tddqWpQmt" },
}
const K256_DOC = {
    "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1",
        "https://w3id.org/security/suites/secp256k1-2019/v1",
    ],
    id: K256_DID,
    alsoKnownAs: K256_OP.alsoKnownAs,
    verificationMethod: [
        {
            id: `${K256_DID}#atproto`,
            type: "Multikey",
            controller: K256_DID,
            publicKeyMultibase: "zQ3shdrX5UZHPdAPDCvCCxGn8mktUByzn2ZrzA24tddqWpQmt",
        },
    ],
    service: [
        {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://phellinus.us-west.host.bsky.network",
        },
    ],
}

function withKey(op: typeof K256_OP, key: string) {
    return { ...op, verificationMethods: { atproto: key } }
}

describe("renderPlcDocument", () => {
    it("renders a live P-256 op identically to the document the directory serves for it, key order included", () => {
        const rendered = renderPlcDocument(P256_DID, P256_OP)
        expect(JSON.stringify(rendered)).toBe(JSON.stringify(P256_DOC))
    })

    it("renders a live secp256k1 op identically to the document the directory serves for it, key order included", () => {
        const rendered = renderPlcDocument(K256_DID, K256_OP)
        expect(JSON.stringify(rendered)).toBe(JSON.stringify(K256_DOC))
    })

    it("publicKeyMultibase is the did:key value without its did:key: prefix", () => {
        const rendered = renderPlcDocument(K256_DID, K256_OP)
        expect(rendered?.verificationMethod?.[0]?.publicKeyMultibase).toBe(
            K256_OP.verificationMethods.atproto.slice("did:key:".length)
        )
    })

    it("verificationMethod ids are <did>#<name>, service ids are #<name>, and controller is the DID", () => {
        const rendered = renderPlcDocument(K256_DID, K256_OP)
        expect(rendered?.verificationMethod?.[0]?.id).toBe(`${K256_DID}#atproto`)
        expect(rendered?.verificationMethod?.[0]?.controller).toBe(K256_DID)
        expect(rendered?.service?.[0]?.id).toBe("#atproto_pds")
    })

    it("returns null for a key family no live fixture pins", () => {
        expect(renderPlcDocument(K256_DID, withKey(K256_OP, "did:key:z6MkOther"))).toBeNull()
        expect(renderPlcDocument(K256_DID, withKey(K256_OP, "did:key:zUnknownFamily"))).toBeNull()
    })

    it("omits rotationKeys", () => {
        const rendered = renderPlcDocument(K256_DID, K256_OP)
        expect(JSON.stringify(rendered)).not.toContain("rotationKeys")
        expect(JSON.stringify(rendered)).not.toContain(K256_OP.rotationKeys[0])
    })

    it("returns null for a legacy create, a tombstone, or an unknown type", () => {
        expect(renderPlcDocument(K256_DID, { ...K256_OP, type: "create" })).toBeNull()
        expect(renderPlcDocument(K256_DID, { type: "plc_tombstone", prev: "x", sig: "y" })).toBeNull()
        expect(renderPlcDocument(K256_DID, { ...K256_OP, type: "something_new" })).toBeNull()
        expect(renderPlcDocument(K256_DID, null)).toBeNull()
        expect(renderPlcDocument(K256_DID, "op")).toBeNull()
    })

    it("returns null when a verificationMethods value is not a did:key:z… string", () => {
        for (const bad of ["zQ3sNoPrefix", "did:key:abc", 7, null]) {
            const op = { ...K256_OP, verificationMethods: { atproto: bad } }
            expect(renderPlcDocument(K256_DID, op)).toBeNull()
        }
    })

    it("returns null when a service lacks a string type or endpoint", () => {
        const svc = K256_OP.services.atproto_pds
        for (const bad of [
            { endpoint: svc.endpoint },
            { type: svc.type },
            { type: 1, endpoint: svc.endpoint },
            { type: svc.type, endpoint: {} },
        ]) {
            const op = { ...K256_OP, services: { atproto_pds: bad } }
            expect(renderPlcDocument(K256_DID, op)).toBeNull()
        }
    })

    it("returns null when alsoKnownAs is not an array of strings", () => {
        for (const bad of ["at://x", [1], null, undefined]) {
            expect(renderPlcDocument(K256_DID, { ...K256_OP, alsoKnownAs: bad })).toBeNull()
        }
    })

    it("returns null for shapes no live document pins: empty or several services, empty alsoKnownAs, several verification methods", () => {
        expect(renderPlcDocument(K256_DID, { ...K256_OP, services: {} })).toBeNull()
        const extra = { ...K256_OP.services, atproto_labeler: K256_OP.services.atproto_pds }
        expect(renderPlcDocument(K256_DID, { ...K256_OP, services: extra })).toBeNull()
        expect(renderPlcDocument(K256_DID, { ...K256_OP, alsoKnownAs: [] })).toBeNull()
        const key = K256_OP.verificationMethods.atproto
        const two = { ...K256_OP, verificationMethods: { atproto: key, other: key } }
        expect(renderPlcDocument(K256_DID, two)).toBeNull()
    })

    it("returns null for verification methods of mixed key families", () => {
        const mixed = {
            ...K256_OP,
            verificationMethods: { atproto: K256_OP.verificationMethods.atproto, other: P256_OP.verificationMethods.atproto },
        }
        expect(renderPlcDocument(K256_DID, mixed)).toBeNull()
    })
})

describe("pdsResolutionFromDocument", () => {
    it.todo("answers the same as resolvePDSEndpoint for the same document")
    it.todo("takes the signing key from the same document")
    it.todo("throws when the document has no #atproto_pds service")
})

describe("storedSigningKeyResolver", () => {
    it.todo("covered plc: uses a document fetched within the max age, without calling fallback")
    it.todo("covered plc: a document fetched before continuousSinceMs is trusted only for the TTL")
    it.todo("coverage lagging more than PLC_COVERAGE_MAX_LAG_MS: a plc document is trusted only for the TTL")
    it.todo("no coverage, or reading it throws: a plc document is trusted only for the TTL")
    it.todo("web: a cached document is trusted only for the TTL, whatever the coverage")
    it.todo("a cached document's source, not the DID string, decides plc vs web trust")
    it.todo("calls fallback when the stored document is past its trust window")
    it.todo("calls fallback when there is no stored document")
    it.todo("calls fallback when reading the stored document throws")
    it.todo("trust windows are inclusive at their bound and stale one ms past it")
})
