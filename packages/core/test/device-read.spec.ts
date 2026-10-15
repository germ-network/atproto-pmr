/**
 * The public read routes answer every caller identically, leave nothing a
 * cache could reveal, never reach a PDS on the response path, and serve held
 * bytes unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { encodeCose, type CoseValue } from "../src/cose/cbor"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import {
    decodeRecordReadResponse,
    dedupedRecheck,
    decodeGraphReadResponse,
    encodeGraphReadResponse,
    encodeRecordReadResponse,
    handleGraphRead,
    handleRecordRead,
    type GraphReadDeps,
    projectGraph,
    type RecordReadDeps,
} from "../src/device-read"
import type { FollowEdge } from "../src/follow-edges"
import {
    GRAPH_EDGE_KEYS,
    GRAPH_READ_KEYS,
    RECORD_READ_KEYS,
    type GraphReadResponse,
    type RecordReadResponse,
} from "../src/read-api"
import { SNAPSHOT_MAX_AGE_MS, type StoredRecordSnapshot } from "../src/snapshot-read"
import { buildRepoCar, makeKey } from "./fixtures/repo-car"

const DID = "did:plc:alice1234567890123456789012"
const COLLECTION = "app.example.thing"
const RKEY = "rk1"
const PATH = `${COLLECTION}/${RKEY}`
const PATH_OK = `/pmr/v1/records/${DID}/${COLLECTION}/${RKEY}`
const NOW = 10_000_000_000
const record = (n: number) => ({ $type: COLLECTION, n })

afterEach(() => vi.restoreAllMocks())

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
        /** Ingest's rev/cid metadata; null models an entry stored without it. */
        metadata?: null
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
                  rev: options.metadata === null ? null : (options.rev ?? "3kaaaaaaaaaaa"),
                  cid: options.metadata === null ? null : repo.recordCids[`${collection}/${rkey}`]!,
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
        signingKeys: {
            keysFor: async (dids) =>
                new Map(dids.map((d) => [d, { kind: "trusted", key: key.multikey } as const])),
        },
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
    it("serves the held CAR byte for byte, with the verified rev and cid and freshAtMs", async () => {
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
        const { deps } = setup({ commitDid: "did:plc:bob12345678901234567890123", metadata: null })
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
        const { deps } = setup({ car: Uint8Array.of(1, 2, 3), metadata: null })
        expect(await miss(PATH_OK, deps)).toMatchObject({ code: "unverifiable" })
    })

    it("a held CAR proving the record absent is not-held", async () => {
        const { deps } = setup({ records: { [`${COLLECTION}/else`]: record(2) }, metadata: null })
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
    const DECL_PATH = `/pmr/v1/records/${DID}/${DECLARATION_COLLECTION_NSID}/self`
    const lapsed = NOW - SNAPSHOT_MAX_AGE_MS - 1

    function withRecheck(options: Parameters<typeof setup>[0]) {
        const s = setup(options)
        const requested: string[] = []
        const waited: Promise<unknown>[] = []
        s.deps.requestRecheck = async (did) => {
            requested.push(did)
        }
        s.deps.waitUntil = (p) => {
            waited.push(p)
        }
        return { ...s, requested, waited }
    }

    it("a lapsed declaration resolves its response even when requestRecheck never settles, and the recheck goes to waitUntil", async () => {
        const { deps, waited, requested } = withRecheck({ declaration: true, freshAtMs: lapsed })
        deps.requestRecheck = (did) => {
            requested.push(did)
            return new Promise<void>(() => {})
        }
        const res = await handleRecordRead(get(DECL_PATH), deps)
        expect(decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer())).found).toBe(true)
        expect(requested).toEqual([DID])
        expect(waited).toHaveLength(1)
    })

    it("the lapsed response is byte-identical to the response for the same snapshot when fresh", async () => {
        const { deps, requested } = withRecheck({ declaration: true, freshAtMs: NOW - 1 })
        const fresh = await handleRecordRead(get(DECL_PATH), deps)
        expect(requested).toEqual([])
        deps.nowMs = () => NOW + SNAPSHOT_MAX_AGE_MS
        const late = await handleRecordRead(get(DECL_PATH), deps)
        expect(requested).toEqual([DID])
        expect([...late.headers]).toEqual([...fresh.headers])
        expect(new Uint8Array(await late.arrayBuffer())).toEqual(
            new Uint8Array(await fresh.arrayBuffer())
        )
    })

    it("a fresh declaration requests no recheck", async () => {
        const { deps, requested, waited } = withRecheck({
            declaration: true,
            freshAtMs: NOW - SNAPSHOT_MAX_AGE_MS,
        })
        await handleRecordRead(get(DECL_PATH), deps)
        expect(requested).toEqual([])
        expect(waited).toEqual([])
    })

    it("a lapsed non-declaration record requests no recheck", async () => {
        const { deps, requested, waited } = withRecheck({ freshAtMs: lapsed })
        const res = await handleRecordRead(get(PATH_OK), deps)
        expect(decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer())).found).toBe(true)
        expect(requested).toEqual([])
        expect(waited).toEqual([])
    })

    it("a rejected recheck does not fail or change the read", async () => {
        const { deps, waited } = withRecheck({ declaration: true, freshAtMs: lapsed })
        deps.requestRecheck = async () => {
            throw new Error("monitor down")
        }
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const res = await handleRecordRead(get(DECL_PATH), deps)
        await Promise.all(waited)
        warn.mockRestore()
        expect(res.status).toBe(200)
        expect(decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer())).found).toBe(true)
    })

    it("a throwing requestRecheck does not fail the read either", async () => {
        const { deps, waited } = withRecheck({ declaration: true, freshAtMs: lapsed })
        deps.requestRecheck = () => {
            throw new Error("sync failure")
        }
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const res = await handleRecordRead(get(DECL_PATH), deps)
        await Promise.all(waited)
        warn.mockRestore()
        expect(res.status).toBe(200)
    })
})

describe("dedupedRecheck", () => {
    const WINDOW = 10_000
    function make(maxEntries?: number, settle = true) {
        let now = 1_000
        const calls: string[] = []
        const fn = dedupedRecheck(
            (did) => {
                calls.push(did)
                return settle ? Promise.resolve() : new Promise<void>(() => {})
            },
            () => now,
            WINDOW,
            maxEntries
        )
        return { fn, calls, advance: (ms: number) => (now += ms) }
    }

    it("a burst of concurrent requests for one DID calls requestRecheck once", async () => {
        const { fn, calls } = make(undefined, false)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        for (let i = 0; i < 5; i++) void fn("did:plc:a")
        await Promise.resolve()
        expect(calls).toEqual(["did:plc:a"])
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it("N requests for one DID within the window call requestRecheck once", async () => {
        const { fn, calls, advance } = make()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        for (let i = 0; i < 5; i++) {
            await fn("did:plc:a")
            advance(WINDOW / 10)
        }
        warn.mockRestore()
        expect(calls).toEqual(["did:plc:a"])
    })

    it("a request after the window calls requestRecheck again", async () => {
        const { fn, calls, advance } = make()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        await fn("did:plc:a")
        advance(WINDOW)
        await fn("did:plc:a")
        warn.mockRestore()
        expect(calls).toEqual(["did:plc:a", "did:plc:a"])
    })

    it("the memo is bounded and drops its oldest entry first", async () => {
        const { fn, calls } = make(3)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        for (let i = 0; i <= 3; i++) await fn(`did:plc:${i}`)
        calls.length = 0
        await fn("did:plc:3")
        expect(calls).toEqual([])
        await fn("did:plc:0")
        warn.mockRestore()
        expect(calls).toEqual(["did:plc:0"])
    })

    it("a lapse is logged once per DID per window, not per read", async () => {
        const { fn, advance } = make()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        await fn("did:plc:a")
        await fn("did:plc:a")
        await fn("did:plc:a")
        expect(warn).toHaveBeenCalledTimes(1)
        advance(WINDOW)
        await fn("did:plc:a")
        expect(warn).toHaveBeenCalledTimes(2)
        warn.mockRestore()
    })
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
    const ME = "did:plc:me"
    const A = "did:plc:a"
    const B = "did:plc:b"
    const edge = (follower: string, subject: string, rkey: string): FollowEdge => ({
        follower,
        subject,
        rkey,
    })

    it("following and followers carry each edge's other party and follow rkey", () => {
        const out = projectGraph(ME, [edge(ME, A, "r1")], [edge(B, ME, "r2")])
        expect(out).toEqual({
            did: ME,
            following: [{ did: A, rkey: "r1", mutual: false }],
            followers: [{ did: B, rkey: "r2", mutual: false }],
        })
    })

    it("an edge is mutual iff a reverse edge is present", () => {
        const out = projectGraph(
            ME,
            [edge(ME, A, "r1"), edge(ME, B, "r2")],
            [edge(A, ME, "r3")]
        )
        expect(out.following).toEqual([
            { did: A, rkey: "r1", mutual: true },
            { did: B, rkey: "r2", mutual: false },
        ])
        expect(out.followers).toEqual([{ did: A, rkey: "r3", mutual: true }])
    })

    it("two follow records of the same pair are two edges", () => {
        const out = projectGraph(ME, [edge(ME, A, "r1"), edge(ME, A, "r2")], [])
        expect(out.following).toEqual([
            { did: A, rkey: "r1", mutual: false },
            { did: A, rkey: "r2", mutual: false },
        ])
    })

    it("edges are sorted by did then rkey, so equal inputs encode to equal bytes", () => {
        const edges = [edge(ME, B, "r2"), edge(ME, A, "r9"), edge(ME, A, "r1"), edge(ME, B, "r1")]
        const inbound = edges.map((e) => edge(e.subject, ME, e.rkey))
        const forward = projectGraph(ME, edges, inbound)
        const reversed = projectGraph(ME, [...edges].reverse(), [...inbound].reverse())
        expect(forward.followers.map((e) => `${e.did}/${e.rkey}`)).toEqual([
            `${A}/r1`,
            `${A}/r9`,
            `${B}/r1`,
            `${B}/r2`,
        ])
        expect(forward.following.map((e) => `${e.did}/${e.rkey}`)).toEqual([
            `${A}/r1`,
            `${A}/r9`,
            `${B}/r1`,
            `${B}/r2`,
        ])
        expect(reversed).toEqual(forward)
    })
})

describe("graph read", () => {
    const GRAPH_DID = "did:plc:me"
    const projection: GraphReadResponse = {
        did: GRAPH_DID,
        following: [{ did: "did:plc:a", rkey: "r1", mutual: true }],
        followers: [
            { did: "did:plc:a", rkey: "r3", mutual: true },
            { did: "did:plc:b", rkey: "r2", mutual: false },
        ],
    }
    const deps = (held: GraphReadResponse | null, asked: string[] = []): GraphReadDeps => ({
        projections: {
            get: async (did) => {
                asked.push(did)
                return held
            },
        },
    })
    const graphGet = (did: string, headers: Record<string, string> = {}) =>
        get(`/pmr/v1/graph/${did}`, headers)

    it("serves the held projection as a GraphReadResponse with cache-control no-store", async () => {
        const asked: string[] = []
        const res = await handleGraphRead(graphGet(GRAPH_DID), deps(projection, asked))
        expect(res.status).toBe(200)
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(res.headers.get("content-type")).toBe("application/cbor")
        expect(res.headers.get("etag")).toBeNull()
        expect(decodeGraphReadResponse(new Uint8Array(await res.arrayBuffer()))).toEqual(projection)
        expect(asked).toEqual([GRAPH_DID])
    })

    it("an escaped DID segment reaches the store decoded", async () => {
        const asked: string[] = []
        await handleGraphRead(graphGet("did%3Aplc%3Ame"), deps(projection, asked))
        expect(asked).toEqual([GRAPH_DID])
    })

    it("a DID with no projection (not served) is 404", async () => {
        const res = await handleGraphRead(graphGet(GRAPH_DID), deps(null))
        expect(res.status).toBe(404)
        expect(res.headers.get("cache-control")).toBe("no-store")
    })

    it("a malformed path is 400 and never reaches the store", async () => {
        const asked: string[] = []
        for (const path of [
            "/pmr/v1/graph",
            "/pmr/v1/graph/not-a-did",
            `/pmr/v1/graph/${GRAPH_DID}/x`,
            "/pmr/v1/graph/%E0%A4%A",
        ]) {
            const res = await handleGraphRead(get(path), deps(projection, asked))
            expect(res.status).toBe(400)
        }
        expect(asked).toEqual([])
    })

    it("answers identically whatever headers or credentials the request carries", async () => {
        const plain = await handleGraphRead(graphGet(GRAPH_DID), deps(projection))
        const decorated = await handleGraphRead(
            graphGet(GRAPH_DID, {
                authorization: "Bearer x",
                signature: "sig1=:AAAA:",
                "if-none-match": '"anything"',
                cookie: "a=b",
            }),
            deps(projection)
        )
        expect(decorated.status).toBe(plain.status)
        expect([...decorated.headers]).toEqual([...plain.headers])
        expect(new Uint8Array(await decorated.arrayBuffer())).toEqual(
            new Uint8Array(await plain.arrayBuffer())
        )
    })

    it("the codec round-trips and ignores unknown keys", () => {
        expect(decodeGraphReadResponse(encodeGraphReadResponse(projection))).toEqual(projection)
        const withUnknown = encodeCose(
            new Map<string, CoseValue>([
                [GRAPH_READ_KEYS.did, GRAPH_DID],
                [
                    GRAPH_READ_KEYS.following,
                    [
                        new Map<string, CoseValue>([
                            [GRAPH_EDGE_KEYS.did, "did:plc:a"],
                            [GRAPH_EDGE_KEYS.rkey, "r1"],
                            [GRAPH_EDGE_KEYS.mutual, false],
                            ["zz", 1],
                        ]),
                    ],
                ],
                [GRAPH_READ_KEYS.followers, []],
                ["zz", "extra"],
            ])
        )
        expect(decodeGraphReadResponse(withUnknown)).toEqual({
            did: GRAPH_DID,
            following: [{ did: "did:plc:a", rkey: "r1", mutual: false }],
            followers: [],
        })
    })

    it("decode rejects a body missing a required field", () => {
        const noFollowers = encodeCose(
            new Map<string, CoseValue>([
                [GRAPH_READ_KEYS.did, GRAPH_DID],
                [GRAPH_READ_KEYS.following, []],
            ])
        )
        expect(() => decodeGraphReadResponse(noFollowers)).toThrow()
        const badEdge = encodeCose(
            new Map<string, CoseValue>([
                [GRAPH_READ_KEYS.did, GRAPH_DID],
                [GRAPH_READ_KEYS.following, [new Map<string, CoseValue>([[GRAPH_EDGE_KEYS.did, "x"]])]],
                [GRAPH_READ_KEYS.followers, []],
            ])
        )
        expect(() => decodeGraphReadResponse(badEdge)).toThrow()
    })
})
