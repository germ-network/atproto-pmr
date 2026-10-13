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
import {
    SNAPSHOT_MAX_AGE_MS,
    snapshotDeclarationResolver,
    type DeclarationSnapshot,
} from "../src/declaration"
import {
    REAL_DID,
    REAL_RECORD_CID,
    REAL_SIGNING_KEY,
    realCar,
} from "./fixtures/real-monitor-car"
import { buildRepoCar, makeKey, type TestKey } from "./fixtures/repo-car"

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

describe("snapshotDeclarationResolver", () => {
    const NOW = 10_000_000_000
    const ANCHOR = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const DECL_PATH = "com.germnetwork.declaration/self"
    const declaration = (currentKey: unknown) => ({
        $type: "com.germnetwork.declaration",
        version: "1.1.0",
        currentKey,
    })

    function setup(
        options: {
            did?: string
            record?: unknown
            commitDid?: string
            key?: TestKey
            signWith?: TestKey
            records?: Record<string, unknown>
            freshAtMs?: number
            snapshot?: "none"
            signingKey?: string | null
        } = {}
    ) {
        const did = options.did ?? PLC_DID
        const key = options.key ?? makeKey()
        const repo = buildRepoCar({
            did,
            commitDid: options.commitDid,
            key,
            signWith: options.signWith,
            records: options.records ?? {
                [DECL_PATH]: options.record ?? declaration(Uint8Array.of(3, ...ANCHOR)),
            },
        })
        const snapshot: DeclarationSnapshot | null =
            options.snapshot === "none"
                ? null
                : { car: repo.car, freshAtMs: options.freshAtMs ?? NOW }
        const dir = directoryFetch({
            [did === WEB_DID ? WEB_URL : PLC_URL]: didDoc(
                did,
                options.signingKey === undefined ? key.multikey : options.signingKey
            ),
        })
        const resolve = snapshotDeclarationResolver({
            getSnapshot: async () => snapshot,
            resolveSigningKey: cachedSigningKeyResolver({
                fetchImpl: dir.fetchImpl,
                cache: { get: async () => null, put: async () => {} },
                nowMs: () => NOW,
            }),
            nowMs: () => NOW,
        })
        return { resolve, repo, urls: dir.urls }
    }

    it("resolves the anchor key and the declaration record CID from a verified snapshot CAR", async () => {
        const t = setup()
        const out = await t.resolve(PLC_DID)
        expect(out).toMatchObject({
            found: true,
            declarationCID: t.repo.recordCids[DECL_PATH],
        })
        if (out.found) expect(Array.from(out.anchorKey.x)).toEqual(Array.from(ANCHOR))
    })

    it("never contacts the sender's PDS: a fetch double that throws on any non-directory host is never hit", async () => {
        const t = setup()
        await t.resolve(PLC_DID)
        expect(t.urls).toEqual([PLC_URL])
        const web = setup({ did: WEB_DID })
        expect(await web.resolve(WEB_DID)).toMatchObject({ found: true })
        expect(web.urls).toEqual([WEB_URL])
    })

    it("a snapshot CAR committed by a different DID → found: false", async () => {
        const t = setup({ commitDid: "did:plc:other00000000000000000000" })
        expect(await t.resolve(PLC_DID)).toMatchObject({ found: false })
    })

    it("no snapshot for the DID → found: false, without fetching anything inline", async () => {
        const t = setup({ snapshot: "none" })
        expect(await t.resolve(PLC_DID)).toMatchObject({ found: false })
        expect(t.urls).toEqual([])
    })

    it("a snapshot whose freshAtMs is older than SNAPSHOT_MAX_AGE_MS → found: false", async () => {
        const edge = setup({ freshAtMs: NOW - SNAPSHOT_MAX_AGE_MS })
        expect(await edge.resolve(PLC_DID)).toMatchObject({ found: true })
        const stale = setup({ freshAtMs: NOW - SNAPSHOT_MAX_AGE_MS - 1 })
        expect(await stale.resolve(PLC_DID)).toMatchObject({ found: false })
        expect(stale.urls).toEqual([])
    })

    it("a getSnapshot fault propagates rather than resolving found: false", async () => {
        const resolve = snapshotDeclarationResolver({
            getSnapshot: async () => {
                throw new Error("kv down")
            },
            resolveSigningKey: async () => KEY_A,
            nowMs: () => NOW,
        })
        await expect(resolve(PLC_DID)).rejects.toThrow("kv down")
    })

    it("snapshot fails verification under the DID's signing key → found: false", async () => {
        expect(await setup({ signWith: makeKey() }).resolve(PLC_DID)).toMatchObject({ found: false })
        // A DID document key that differs from the one that signed the CAR.
        expect(await setup({ signingKey: makeKey().multikey }).resolve(PLC_DID)).toMatchObject({
            found: false,
        })
    })

    it("no #atproto signing key in the DID document → found: false", async () => {
        expect(await setup({ signingKey: null }).resolve(PLC_DID)).toMatchObject({ found: false })
    })

    it("record present but currentKey missing or not alg byte 3 → found: false", async () => {
        for (const record of [
            { $type: "com.germnetwork.declaration", version: "1.1.0" },
            declaration("text"),
            declaration({ $bytes: "AgECAw" }),
            declaration(Uint8Array.of(2, ...ANCHOR)),
            declaration(Uint8Array.of(3, ...ANCHOR.subarray(1))),
        ]) {
            const t = setup({ record })
            expect(await t.resolve(PLC_DID)).toMatchObject({ found: false })
        }
    })

    it("record-absent proof → found: false", async () => {
        const t = setup({ records: { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } } })
        expect(await t.resolve(PLC_DID)).toMatchObject({ found: false })
    })

    it("resolves the captured real-world 1.1.0 declaration (currentKey leading byte 0x03) to its record CID", async () => {
        const resolve = snapshotDeclarationResolver({
            getSnapshot: async () => ({ car: realCar(), freshAtMs: NOW }),
            resolveSigningKey: async () => REAL_SIGNING_KEY,
            nowMs: () => NOW,
        })
        const out = await resolve(REAL_DID)
        expect(out).toMatchObject({ found: true, declarationCID: REAL_RECORD_CID })
    })
})
