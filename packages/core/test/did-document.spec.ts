/**
 * The stored DID document: rendering one from a PLC operation exactly as the
 * directory presents it, and the relay trusting a stored one only while it
 * is fresh.
 */
import { describe, expect, it } from "vitest"
import { pdsResolutionFromDocument, resolvePDSEndpoint, SIGNING_KEY_TTL_MS } from "../src/atproto-fetch"
import {
    PLC_COVERAGE_MAX_LAG_MS,
    renderPlcDocument,
    STORED_DID_DOCUMENT_MAX_AGE_MS,
    storedSigningKeyResolver,
    type CachedDidDocument,
    type PlcCoverage,
} from "../src/did-document"

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
    const DOC = K256_DOC as unknown as Record<string, unknown>

    it("answers the same as resolvePDSEndpoint for the same document", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify(DOC), { status: 200 })) as typeof fetch
        expect(pdsResolutionFromDocument(DOC)).toEqual(
            await resolvePDSEndpoint(K256_DID, fetchImpl)
        )
    })

    it("takes the signing key from the same document", () => {
        expect(pdsResolutionFromDocument(DOC)).toEqual({
            endpoint: "https://phellinus.us-west.host.bsky.network",
            signingKey: "zQ3shdrX5UZHPdAPDCvCCxGn8mktUByzn2ZrzA24tddqWpQmt",
        })
    })

    it("throws when the document has no #atproto_pds service", () => {
        expect(() => pdsResolutionFromDocument({ ...DOC, service: [] })).toThrow(
            /no #atproto_pds service/
        )
    })
})

describe("storedSigningKeyResolver", () => {
    const NOW = 1_700_000_000_000
    const KEY = "zQ3shdrX5UZHPdAPDCvCCxGn8mktUByzn2ZrzA24tddqWpQmt"
    const FALLBACK_KEY = "zQ3sFallback"
    const MINUTE = 60_000
    const HOUR = 60 * MINUTE

    const coverage = (over: Partial<PlcCoverage> = {}): PlcCoverage => ({
        url: "https://plc.example/export/stream",
        continuousSinceMs: NOW - 48 * HOUR,
        coveredThroughMs: NOW - MINUTE,
        ...over,
    })

    function setup(opts: {
        cached?: CachedDidDocument | null | "throws"
        coverage?: PlcCoverage | null | "throws"
    }) {
        const calls = { documents: 0, coverage: 0, fallback: 0 }
        const resolve = storedSigningKeyResolver({
            documents: {
                get: async () => {
                    calls.documents++
                    if (opts.cached === "throws") throw new Error("kv down")
                    return opts.cached ?? null
                },
            },
            getPlcCoverage: async () => {
                calls.coverage++
                if (opts.coverage === "throws") throw new Error("kv down")
                return opts.coverage ?? null
            },
            fallback: async () => {
                calls.fallback++
                return FALLBACK_KEY
            },
            nowMs: () => NOW,
        })
        return { resolve, calls }
    }

    const cachedAt = (
        fetchedAtMs: number,
        source: "plc" | "web" = "plc"
    ): CachedDidDocument => ({
        doc: K256_DOC as unknown as CachedDidDocument["doc"],
        fetchedAtMs,
        source,
    })

    it("covered plc: uses a document fetched within the max age, without calling fallback", async () => {
        const { resolve, calls } = setup({
            cached: cachedAt(NOW - 20 * HOUR),
            coverage: coverage(),
        })
        expect(await resolve(K256_DID)).toBe(KEY)
        expect(calls.fallback).toBe(0)
    })

    it("covered plc: a document fetched before continuousSinceMs is trusted only for the TTL", async () => {
        const cov = coverage({ continuousSinceMs: NOW - 2 * HOUR })
        const old = setup({ cached: cachedAt(NOW - 3 * HOUR), coverage: cov })
        expect(await old.resolve(K256_DID)).toBe(FALLBACK_KEY)
        const recent = setup({ cached: cachedAt(NOW - 5 * MINUTE), coverage: cov })
        expect(await recent.resolve(K256_DID)).toBe(KEY)
        expect(recent.calls.fallback).toBe(0)
    })

    it("coverage lagging more than PLC_COVERAGE_MAX_LAG_MS: a plc document is trusted only for the TTL", async () => {
        const cov = coverage({ coveredThroughMs: NOW - PLC_COVERAGE_MAX_LAG_MS - 1 })
        const old = setup({ cached: cachedAt(NOW - HOUR), coverage: cov })
        expect(await old.resolve(K256_DID)).toBe(FALLBACK_KEY)
        const recent = setup({ cached: cachedAt(NOW - 5 * MINUTE), coverage: cov })
        expect(await recent.resolve(K256_DID)).toBe(KEY)
    })

    it("no coverage, or reading it throws: a plc document is trusted only for the TTL", async () => {
        for (const cov of [null, "throws"] as const) {
            const old = setup({ cached: cachedAt(NOW - HOUR), coverage: cov })
            expect(await old.resolve(K256_DID)).toBe(FALLBACK_KEY)
            const recent = setup({ cached: cachedAt(NOW - 5 * MINUTE), coverage: cov })
            expect(await recent.resolve(K256_DID)).toBe(KEY)
            expect(recent.calls.fallback).toBe(0)
        }
    })

    it("web: a cached document is trusted only for the TTL, whatever the coverage", async () => {
        const old = setup({ cached: cachedAt(NOW - HOUR, "web"), coverage: coverage() })
        expect(await old.resolve(K256_DID)).toBe(FALLBACK_KEY)
        expect(old.calls.coverage).toBe(0)
        const recent = setup({ cached: cachedAt(NOW - 5 * MINUTE, "web"), coverage: null })
        expect(await recent.resolve(K256_DID)).toBe(KEY)
    })

    it("a cached document's source, not the DID string, decides plc vs web trust", async () => {
        const webLooking = setup({
            cached: cachedAt(NOW - HOUR, "plc"),
            coverage: coverage(),
        })
        expect(await webLooking.resolve("did:web:example.com")).toBe(KEY)
        const plcLooking = setup({
            cached: cachedAt(NOW - HOUR, "web"),
            coverage: coverage(),
        })
        expect(await plcLooking.resolve(K256_DID)).toBe(FALLBACK_KEY)
    })

    it("coverage lag is ten minutes", async () => {
        const behind = (ms: number) =>
            setup({
                cached: cachedAt(NOW - HOUR),
                coverage: coverage({ coveredThroughMs: NOW - ms }),
            }).resolve(K256_DID)
        expect(await behind(9 * MINUTE)).toBe(KEY)
        expect(await behind(11 * MINUTE)).toBe(FALLBACK_KEY)
    })

    it("a cached entry with no usable fetchedAtMs is not trusted", async () => {
        for (const bad of [Number.NaN, undefined as unknown as number]) {
            const { resolve } = setup({ cached: cachedAt(bad), coverage: coverage() })
            expect(await resolve(K256_DID)).toBe(FALLBACK_KEY)
        }
    })

    it("calls fallback when the stored document is past its trust window", async () => {
        const { resolve, calls } = setup({
            cached: cachedAt(NOW - 25 * HOUR),
            coverage: coverage(),
        })
        expect(await resolve(K256_DID)).toBe(FALLBACK_KEY)
        expect(calls.fallback).toBe(1)
    })

    it("calls fallback when there is no stored document", async () => {
        const { resolve, calls } = setup({ cached: null, coverage: coverage() })
        expect(await resolve(K256_DID)).toBe(FALLBACK_KEY)
        expect(calls.fallback).toBe(1)
        expect(calls.coverage).toBe(0)
    })

    it("calls fallback when reading the stored document throws", async () => {
        const { resolve, calls } = setup({ cached: "throws", coverage: coverage() })
        expect(await resolve(K256_DID)).toBe(FALLBACK_KEY)
        expect(calls.fallback).toBe(1)
    })

    it("trust windows are inclusive at their bound and stale one ms past it", async () => {
        const at = (age: number, source: "plc" | "web", cov: PlcCoverage | null) =>
            setup({ cached: cachedAt(NOW - age, source), coverage: cov }).resolve(K256_DID)
        expect(await at(STORED_DID_DOCUMENT_MAX_AGE_MS, "plc", coverage())).toBe(KEY)
        expect(await at(STORED_DID_DOCUMENT_MAX_AGE_MS + 1, "plc", coverage())).toBe(FALLBACK_KEY)
        expect(await at(SIGNING_KEY_TTL_MS, "web", null)).toBe(KEY)
        expect(await at(SIGNING_KEY_TTL_MS + 1, "web", null)).toBe(FALLBACK_KEY)

        const edge = (over: Partial<PlcCoverage>) =>
            at(HOUR, "plc", coverage(over))
        expect(await edge({ coveredThroughMs: NOW - PLC_COVERAGE_MAX_LAG_MS })).toBe(KEY)
        expect(await edge({ coveredThroughMs: NOW - PLC_COVERAGE_MAX_LAG_MS - 1 })).toBe(FALLBACK_KEY)
        expect(await edge({ continuousSinceMs: NOW - HOUR })).toBe(KEY)
        expect(await edge({ continuousSinceMs: NOW - HOUR + 1 })).toBe(FALLBACK_KEY)
    })
})
