/**
 * The public read routes answer every caller identically, leave nothing a
 * cache could reveal, never reach a PDS on the response path, and serve held
 * bytes unchanged.
 */
import { describe, expect, it } from "vitest"
import { encodeCose, type CoseValue } from "../src/cose/cbor"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import {
    decodeRecordReadResponse,
    encodeRecordReadResponse,
    handleRecordRead,
    type RecordReadDeps,
} from "../src/device-read"
import { RECORD_READ_KEYS, type RecordReadResponse } from "../src/read-api"
import type { StoredRecordSnapshot } from "../src/snapshot-read"
import { buildRepoCar, makeKey } from "./fixtures/repo-car"

const DID = "did:plc:alice1234567890123456789012"
const COLLECTION = "app.example.thing"
const RKEY = "rk1"
const PATH = `${COLLECTION}/${RKEY}`
const PATH_OK = `/pmr/v1/records/${DID}/${COLLECTION}/${RKEY}`
const NOW = 10_000_000_000
const record = (n: number) => ({ $type: COLLECTION, n })

const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://pmr.example${path}`, { headers })

function setup(
    options: {
        rev?: string
        freshAtMs?: number
        snapshot?: null
        verifiedWith?: string | null
        car?: Uint8Array
        records?: Record<string, unknown>
        serves?: boolean
        watched?: RecordReadDeps["watched"]
        declaration?: boolean
        commitDid?: string
    } = {}
) {
    const collection = options.declaration ? DECLARATION_COLLECTION_NSID : COLLECTION
    const rkey = options.declaration ? "self" : RKEY
    const key = makeKey()
    const repo = buildRepoCar({
        did: DID,
        key,
        rev: options.rev,
        commitDid: options.commitDid,
        records: options.records ?? { [`${collection}/${rkey}`]: record(1) },
    })
    const stored: StoredRecordSnapshot | null =
        options.snapshot === null
            ? null
            : {
                  car: options.car ?? repo.car,
                  freshAtMs: options.freshAtMs ?? NOW,
                  verifiedWith: options.verifiedWith === undefined ? key.multikey : options.verifiedWith,
              }
    const asked: string[] = []
    const deps: RecordReadDeps = {
        records: {
            get: async (did, c, r) => {
                asked.push(`${did}/${c}/${r}`)
                return stored
            },
        },
        serves: async () => options.serves ?? true,
        watched: options.watched ?? [{ collection: COLLECTION, rkey: RKEY }],
        nowMs: () => NOW,
        requestRecheck: async () => {},
        waitUntil: () => {},
    }
    return { deps, repo, asked }
}

async function miss(path: string, deps: RecordReadDeps) {
    const res = await handleRecordRead(get(path), deps)
    const body = decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer()))
    expect(body.found).toBe(false)
    return body
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
        return i
    }
    return -1
}

describe("record read", () => {
    it("serves the held CAR byte for byte, with rev and cid from a non-verifying parse and freshAtMs", async () => {
        const { deps, repo } = setup({ rev: "3kbbbbbbbbbbb", freshAtMs: NOW - 5 })
        const res = await handleRecordRead(get(PATH_OK), deps)
        const body = decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer()))
        expect(body).toEqual({
            found: true,
            car: repo.car,
            rev: "3kbbbbbbbbbbb",
            cid: repo.recordCids[PATH],
            freshAtMs: NOW - 5,
        })
    })

    it("answers with identical status, headers and body whatever headers or credentials the request carries", async () => {
        const { deps } = setup({ freshAtMs: NOW - 7 })
        const plain = await handleRecordRead(get(PATH_OK), deps)
        const decorated = await handleRecordRead(
            get(PATH_OK, {
                authorization: "Bearer x",
                signature: "sig1=:AAAA:",
                cookie: "a=b",
                "if-none-match": '"anything"',
                "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
                "x-forwarded-for": "203.0.113.9",
            }),
            deps
        )
        expect(decorated.status).toBe(plain.status)
        expect([...decorated.headers]).toEqual([...plain.headers])
        expect(new Uint8Array(await decorated.arrayBuffer())).toEqual(
            new Uint8Array(await plain.arrayBuffer())
        )
    })

    it("every response, found or not, is 200 with cache-control no-store and no ETag or Last-Modified", async () => {
        const { deps } = setup()
        const missing = setup({ snapshot: null })
        for (const res of [
            await handleRecordRead(get(PATH_OK), deps),
            await handleRecordRead(get(`/pmr/v1/records/${DID}/${COLLECTION}/other`), deps),
            await handleRecordRead(get(PATH_OK), missing.deps),
        ]) {
            expect(res.status).toBe(200)
            expect(res.headers.get("cache-control")).toBe("no-store")
            expect(res.headers.get("content-type")).toBe("application/cbor")
            expect(res.headers.get("etag")).toBeNull()
            expect(res.headers.get("last-modified")).toBeNull()
        }
    })

    it("a collection/rkey this PMR does not watch is not-watched", async () => {
        const { deps, asked } = setup()
        for (const path of [
            `/pmr/v1/records/${DID}/${COLLECTION}/other`,
            `/pmr/v1/records/${DID}/app.example.unwatched/${RKEY}`,
        ]) {
            expect(await miss(path, deps)).toMatchObject({ code: "not-watched" })
        }
        expect(asked).toEqual([])
    })

    it("a DID the deployment does not serve is not-watched even when a snapshot is held", async () => {
        const { deps, asked } = setup({ serves: false })
        const res = await miss(PATH_OK, deps)
        expect(res).toMatchObject({ code: "not-watched" })
        expect(asked).toEqual([])
    })

    it("the declaration is never not-watched", async () => {
        const { deps } = setup({ watched: [], declaration: true })
        const res = await handleRecordRead(
            get(`/pmr/v1/records/${DID}/${DECLARATION_COLLECTION_NSID}/self`),
            deps
        )
        expect(decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer())).found).toBe(true)
    })

    it("only the declaration's own rkey is exempt from the watched set", async () => {
        const { deps, asked } = setup({ watched: [] })
        const res = await miss(`/pmr/v1/records/${DID}/${DECLARATION_COLLECTION_NSID}/other`, deps)
        expect(res).toMatchObject({ code: "not-watched" })
        expect(asked).toEqual([])
    })

    it("the declaration of a DID the deployment does not serve is not-watched", async () => {
        const { deps, asked } = setup({ declaration: true, serves: false })
        const res = await miss(`/pmr/v1/records/${DID}/${DECLARATION_COLLECTION_NSID}/self`, deps)
        expect(res).toMatchObject({ code: "not-watched" })
        expect(asked).toEqual([])
    })

    it("a snapshot whose commit is for another DID is unverifiable", async () => {
        const { deps } = setup({ commitDid: "did:plc:bob12345678901234567890123" })
        expect(await miss(PATH_OK, deps)).toMatchObject({ code: "unverifiable" })
    })

    it("a watched record with no snapshot is not-held", async () => {
        const { deps } = setup({ snapshot: null })
        expect(await miss(PATH_OK, deps)).toMatchObject({ code: "not-held" })
    })

    it("a snapshot ingest did not verify (verifiedWith null) is unverifiable and its bytes are not served", async () => {
        const { deps, repo } = setup({ verifiedWith: null })
        const res = await handleRecordRead(get(PATH_OK), deps)
        const bytes = new Uint8Array(await res.arrayBuffer())
        expect(decodeRecordReadResponse(bytes)).toMatchObject({
            found: false,
            code: "unverifiable",
        })
        expect(indexOfBytes(bytes, repo.car)).toBe(-1)
    })

    it("a held CAR that does not parse is unverifiable", async () => {
        const { deps } = setup({ car: Uint8Array.of(1, 2, 3) })
        expect(await miss(PATH_OK, deps)).toMatchObject({ code: "unverifiable" })
    })

    it("a held CAR proving the record absent is not-held", async () => {
        const { deps } = setup({ records: { [`${COLLECTION}/else`]: record(2) } })
        expect(await miss(PATH_OK, deps)).toMatchObject({ code: "not-held" })
    })

    it("a malformed path is 400", async () => {
        const { deps } = setup()
        for (const path of [
            "/pmr/v1/records",
            `/pmr/v1/records/${DID}`,
            `/pmr/v1/records/${DID}/${COLLECTION}`,
            `/pmr/v1/records/${DID}/${COLLECTION}/${RKEY}/extra`,
            `/pmr/v1/records//${COLLECTION}/${RKEY}`,
            `/pmr/v1/records/${DID}/${COLLECTION}/%E0%A4%A`,
            `/pmr/v1/records/not-a-did/${COLLECTION}/${RKEY}`,
            `/pmr/v1/records/did:plc:a%2Fb/${COLLECTION}/${RKEY}`,
        ]) {
            const res = await handleRecordRead(get(path), deps)
            expect(res.status).toBe(400)
            expect(res.headers.get("cache-control")).toBe("no-store")
        }
    })
})

describe("record read past the 24-hour rule", () => {
    it.todo("a lapsed declaration resolves its response even when requestRecheck never settles, and the recheck goes to waitUntil")
    it.todo("the lapsed response is byte-identical to the response for the same snapshot when fresh")
    it.todo("a fresh declaration requests no recheck")
    it.todo("a lapsed non-declaration record requests no recheck")
    it.todo("a rejected recheck does not fail or change the read")
})

describe("dedupedRecheck", () => {
    it.todo("N requests for one DID within the window call requestRecheck once")
    it.todo("a request after the window calls requestRecheck again")
    it.todo("the memo is bounded and drops its oldest entry first")
    it.todo("a lapse is logged once per DID per window, not per read")
})

describe("record read codec", () => {
    const found: RecordReadResponse = {
        found: true,
        car: Uint8Array.of(1, 2, 3),
        rev: "3kaaaaaaaaaaa",
        cid: "bafyreiexample",
        freshAtMs: 1234,
    }
    const misses: RecordReadResponse[] = (["not-watched", "not-held", "unverifiable"] as const).map(
        (code) => ({ found: false, code, reason: `why ${code}` })
    )

    it("found and each miss round-trip through encode and decode", () => {
        for (const response of [found, ...misses]) {
            expect(decodeRecordReadResponse(encodeRecordReadResponse(response))).toEqual(response)
        }
    })

    it("decode ignores unknown keys", () => {
        const bytes = encodeCose(
            new Map<string, CoseValue>([
                [RECORD_READ_KEYS.found, false],
                [RECORD_READ_KEYS.code, "not-held"],
                [RECORD_READ_KEYS.reason, "r"],
                ["zz", 7],
            ])
        )
        expect(decodeRecordReadResponse(bytes)).toEqual({
            found: false,
            code: "not-held",
            reason: "r",
        })
    })

    it("decode rejects a body missing a required field", () => {
        const withoutCid = new Map<string, CoseValue>([
            [RECORD_READ_KEYS.found, true],
            [RECORD_READ_KEYS.car, found.car as Uint8Array],
            [RECORD_READ_KEYS.rev, "r"],
            [RECORD_READ_KEYS.freshAtMs, 1],
        ])
        expect(() => decodeRecordReadResponse(encodeCose(withoutCid))).toThrow()
        const unknownCode = new Map<string, CoseValue>([
            [RECORD_READ_KEYS.found, false],
            [RECORD_READ_KEYS.code, "bogus"],
            [RECORD_READ_KEYS.reason, "r"],
        ])
        expect(() => decodeRecordReadResponse(encodeCose(unknownCode))).toThrow()
        const withoutCode = new Map<string, CoseValue>([[RECORD_READ_KEYS.found, false]])
        expect(() => decodeRecordReadResponse(encodeCose(withoutCode))).toThrow()
    })
})

describe("projectGraph", () => {
    it.todo("following and followers carry each edge's other party and follow rkey")
    it.todo("an edge is mutual iff a reverse edge is present")
    it.todo("two follow records of the same pair are two edges")
    it.todo("edges are sorted by did then rkey, so equal inputs encode to equal bytes")
})

describe("graph read", () => {
    it.todo("serves the held projection as a GraphReadResponse with cache-control no-store")
    it.todo("a DID with no projection (not served) is 404")
    it.todo("answers identically whatever headers or credentials the request carries")
    it.todo("the codec round-trips and ignores unknown keys")
})
