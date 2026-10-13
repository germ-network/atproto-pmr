/**
 * The sender-declaration resolver used by pair put: third-party snapshot
 * only, verified, and never the sender's PDS.
 */
import { describe, expect, it } from "vitest"
import {
    SIGNING_KEY_MAX_STALE_MS,
    SIGNING_KEY_TTL_MS,
    cachedSigningKeyResolver,
    resolveSigningKey,
    type CachedSigningKey,
    type SigningKeyCache,
} from "../src/atproto-fetch"

describe("snapshotDeclarationResolver", () => {
    it.todo("resolves the anchor key and the declaration record CID from a verified snapshot CAR")
    it.todo("never contacts the sender's PDS: a fetch double that throws on any non-directory host is never hit")
    it.todo("no snapshot for the DID → found: false, without fetching anything inline")
    it.todo("a snapshot whose freshAtMs is older than SNAPSHOT_MAX_AGE_MS → found: false")
    it.todo("a getSnapshot fault propagates rather than resolving found: false")
    it.todo("snapshot fails verification under the DID's signing key → found: false")
    it.todo("no #atproto signing key in the DID document → found: false")
    it.todo("record present but currentKey missing or not alg byte 2 → found: false")
    it.todo("record-absent proof → found: false")
})

const PLC_DID = "did:plc:alice1234567890123456789012"
const WEB_DID = "did:web:example.com"
const KEY_A = "zQ3shAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const KEY_B = "zQ3shBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

function didDoc(did: string, key: string | null, withPDS = true) {
    return {
        id: did,
        verificationMethod: key
            ? [{ id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: key }]
            : [],
        service: withPDS
            ? [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }]
            : [],
    }
}

/** Serves DID documents from the two directories; any other URL is recorded and rejected. */
function directoryFetch(docs: Record<string, unknown>) {
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = input.toString()
        urls.push(url)
        const doc = docs[url]
        if (doc === undefined) throw new Error(`unexpected fetch: ${url}`)
        return new Response(JSON.stringify(doc), { status: 200 })
    }) as typeof fetch
    return { fetchImpl, urls }
}

const PLC_URL = `https://plc.directory/${encodeURIComponent(PLC_DID)}`
const WEB_URL = "https://example.com/.well-known/did.json"

describe("resolveSigningKey", () => {
    it("did:plc reads only plc.directory and returns the #atproto multikey", async () => {
        const { fetchImpl, urls } = directoryFetch({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        expect(await resolveSigningKey(PLC_DID, fetchImpl)).toBe(KEY_A)
        expect(urls).toEqual([PLC_URL])
    })

    it("did:web reads only the .well-known DID document, never the PDS endpoint it names", async () => {
        const { fetchImpl, urls } = directoryFetch({ [WEB_URL]: didDoc(WEB_DID, KEY_A) })
        expect(await resolveSigningKey(WEB_DID, fetchImpl)).toBe(KEY_A)
        expect(urls).toEqual([WEB_URL])
    })

    it("a DID document with no #atproto_pds service still yields its signing key", async () => {
        const { fetchImpl } = directoryFetch({ [PLC_URL]: didDoc(PLC_DID, KEY_A, false) })
        expect(await resolveSigningKey(PLC_DID, fetchImpl)).toBe(KEY_A)
    })

    it("a DID document whose id differs from the requested DID is rejected", async () => {
        const { fetchImpl } = directoryFetch({
            [PLC_URL]: didDoc("did:plc:someoneelse00000000000000", KEY_A),
        })
        await expect(resolveSigningKey(PLC_DID, fetchImpl)).rejects.toThrow(/does not match/)
    })
})

describe("cachedSigningKeyResolver", () => {
    function setup(docs: Record<string, unknown>) {
        const store = new Map<string, CachedSigningKey>()
        const cache: SigningKeyCache = {
            get: async (did) => store.get(did) ?? null,
            put: async (did, entry) => void store.set(did, entry),
        }
        let now = 1_000_000
        const dir = directoryFetch(docs)
        const resolve = cachedSigningKeyResolver({
            fetchImpl: dir.fetchImpl,
            cache,
            nowMs: () => now,
        })
        return {
            resolve,
            store,
            urls: dir.urls,
            docs,
            advance: (ms: number) => void (now += ms),
            now: () => now,
        }
    }

    it("a cached key younger than SIGNING_KEY_TTL_MS is returned without a fetch", async () => {
        const t = setup({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        expect(await t.resolve(PLC_DID)).toBe(KEY_A)
        t.advance(SIGNING_KEY_TTL_MS - 1)
        expect(await t.resolve(PLC_DID)).toBe(KEY_A)
        expect(t.urls).toHaveLength(1)
    })

    it("an older cached key triggers a directory fetch and the fresh key replaces it", async () => {
        const t = setup({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        await t.resolve(PLC_DID)
        t.advance(SIGNING_KEY_TTL_MS)
        await t.resolve(PLC_DID)
        expect(t.urls).toHaveLength(2)
        expect(t.store.get(PLC_DID)).toEqual({ key: KEY_A, fetchedAtMs: t.now() })
    })

    it("a rotated key in the directory is returned on the first fetch past the TTL", async () => {
        const t = setup({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        expect(await t.resolve(PLC_DID)).toBe(KEY_A)
        t.docs[PLC_URL] = didDoc(PLC_DID, KEY_B)
        t.advance(SIGNING_KEY_TTL_MS - 1)
        expect(await t.resolve(PLC_DID)).toBe(KEY_A)
        t.advance(1)
        expect(await t.resolve(PLC_DID)).toBe(KEY_B)
    })

    it("a directory failure falls back to a cached key up to SIGNING_KEY_MAX_STALE_MS old", async () => {
        const t = setup({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        await t.resolve(PLC_DID)
        delete t.docs[PLC_URL]
        t.advance(SIGNING_KEY_MAX_STALE_MS)
        expect(await t.resolve(PLC_DID)).toBe(KEY_A)
    })

    it("a directory failure with no cached key, or one older than the max-stale bound, resolves null", async () => {
        const t = setup({})
        expect(await t.resolve(PLC_DID)).toBeNull()
        t.store.set(PLC_DID, { key: KEY_A, fetchedAtMs: t.now() })
        t.advance(SIGNING_KEY_MAX_STALE_MS + 1)
        expect(await t.resolve(PLC_DID)).toBeNull()
    })

    it("a plc tombstone resolves null even with a stale cached key, and is cached for the TTL", async () => {
        const t = setup({})
        t.store.set(PLC_DID, { key: KEY_A, fetchedAtMs: t.now() - SIGNING_KEY_TTL_MS - 1 })
        const tombstoned = cachedSigningKeyResolver({
            fetchImpl: (async (input: RequestInfo | URL) => {
                t.urls.push(input.toString())
                return new Response(JSON.stringify({ message: `DID not available: ${PLC_DID}` }), { status: 404 })
            }) as typeof fetch,
            cache: { get: async (d) => t.store.get(d) ?? null, put: async (d, e) => void t.store.set(d, e) },
            nowMs: () => t.now(),
        })
        expect(await tombstoned(PLC_DID)).toBeNull()
        expect(await tombstoned(PLC_DID)).toBeNull()
        expect(t.urls).toHaveLength(1)
    })

    it("a document without #atproto caches a null key for the TTL", async () => {
        const t = setup({ [PLC_URL]: didDoc(PLC_DID, null) })
        expect(await t.resolve(PLC_DID)).toBeNull()
        expect(await t.resolve(PLC_DID)).toBeNull()
        expect(t.urls).toHaveLength(1)
    })

    it("a cache that throws on get or put does not stop resolution", async () => {
        const dir = directoryFetch({ [PLC_URL]: didDoc(PLC_DID, KEY_A) })
        const resolve = cachedSigningKeyResolver({
            fetchImpl: dir.fetchImpl,
            cache: {
                get: async () => {
                    throw new Error("kv down")
                },
                put: async () => {
                    throw new Error("kv down")
                },
            },
            nowMs: () => 1,
        })
        expect(await resolve(PLC_DID)).toBe(KEY_A)
    })
})
