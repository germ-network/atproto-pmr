/**
 * The owner's summary carries the full CARs of their graph's records. A read
 * names the state the client holds and gets only what changed since; a client
 * that names nothing, or a state no longer held, gets everything, so no lost
 * response, lost state or second device leaves a client wrong.
 */
import { describe, expect, it } from "vitest"
import { ed25519 } from "@noble/curves/ed25519.js"
import { encodeBinding } from "../src/challenge"
import { encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import { signRequest } from "../src/http-sig/sign"
import { handleSummaryRead, type OwnerDeps } from "../src/owner/endpoints"
import type { GraphReadResponse } from "../src/read-api"
import { readRecordFromCar } from "../src/repo-proof"
import type { RecordSnapshotStore } from "../src/snapshot-read"
import type { ChallengeStore, Directory, Locator, PMRStore, RegistrationFields } from "../src/storage"
import {
    buildSummary,
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    SUMMARY_DELTA_KEYS,
    SUMMARY_RECORD_KEYS,
    SUMMARY_TOKENS_KEPT,
    type SummaryDelta,
    type SummaryDeps,
    type SummaryIndex,
} from "../src/summary"
import { buildRepoCar, makeKey } from "./fixtures/repo-car"

describe("buildSummary", () => {
    const ME = "did:plc:me"
    const A = "did:plc:a"
    const B = "did:plc:b"
    const C = "did:plc:c"
    const WATCHED = [
        { collection: DECLARATION_COLLECTION_NSID, rkey: "self" },
        { collection: "app.example.thing", rkey: "self" },
    ]
    const graph = (): GraphReadResponse => ({
        did: ME,
        following: [{ did: A, rkey: "r1", mutual: false }],
        followers: [{ did: B, rkey: "r2", mutual: false }],
    })

    interface Held {
        verifiedWith?: string | null
        car?: Uint8Array
        absent?: boolean
        commitDid?: string
    }
    function setup(held: Record<string, Held> = {}, projection: GraphReadResponse | null = graph()) {
        const key = makeKey()
        const built = new Map<string, ReturnType<typeof buildRepoCar>>()
        const asked: string[] = []
        const deps: SummaryDeps = {
            projections: { get: async () => projection },
            watched: WATCHED,
            records: {
                get: async (did, collection, rkey) => {
                    const id = `${did}|${collection}/${rkey}`
                    asked.push(id)
                    const h = held[id]
                    if (!h) return null
                    const repo = buildRepoCar({
                        did,
                        key,
                        commitDid: h.commitDid,
                        records: h.absent ? {} : { [`${collection}/${rkey}`]: { $type: collection, id } },
                    })
                    built.set(id, repo)
                    return {
                        car: h.car ?? repo.car,
                        freshAtMs: 0,
                        verifiedWith: h.verifiedWith === undefined ? key.multikey : h.verifiedWith,
                    }
                },
            },
        }
        return { deps, built, key, asked }
    }
    const id = (did: string, c = "app.example.thing") => `${did}|${c}/self`

    it("includes every watched record of the owner and of each DID in the owner's projection", async () => {
        const { deps } = setup({
            [id(ME)]: {},
            [id(A)]: {},
            [id(B)]: {},
            [id(A, DECLARATION_COLLECTION_NSID)]: {},
            [id(C)]: {},
        })
        const out = await buildSummary(ME, deps)
        expect(out!.index.records.map((r) => `${r.did}|${r.collection}`)).toEqual([
            `${A}|app.example.thing`,
            `${A}|${DECLARATION_COLLECTION_NSID}`,
            `${B}|app.example.thing`,
            `${ME}|app.example.thing`,
        ])
        expect(out!.index.graph).toEqual(graph())
    })

    it("leaves out records not held, not verified at ingest, or whose CAR does not parse", async () => {
        const { deps } = setup({
            [id(ME)]: {},
            [id(A)]: { verifiedWith: null },
            [id(B)]: { car: Uint8Array.of(1, 2, 3) },
            [id(A, DECLARATION_COLLECTION_NSID)]: { absent: true },
            [id(ME, DECLARATION_COLLECTION_NSID)]: { commitDid: C },
        })
        const out = await buildSummary(ME, deps)
        expect(out!.index.records.map((r) => r.did)).toEqual([ME])
        expect(out!.records.map((r) => r.did)).toEqual([ME])
    })

    it("is null when the owner has no projection", async () => {
        const { deps, asked } = setup({ [id(ME)]: {} }, null)
        expect(await buildSummary(ME, deps)).toBeNull()
        expect(asked).toEqual([])
    })

    it("never requests a recheck, even for a lapsed declaration", async () => {
        // SummaryDeps carries no recheck seam, so a lapsed declaration is
        // served from the store as held and the store is read once per record.
        const { deps, asked } = setup({ [id(ME, DECLARATION_COLLECTION_NSID)]: {} })
        const out = await buildSummary(ME, deps)
        expect(out!.records.map((r) => r.collection)).toEqual([DECLARATION_COLLECTION_NSID])
        expect(asked).toHaveLength(3 * WATCHED.length)
        expect(new Set(asked).size).toBe(asked.length)
    })

    it("each record's CAR is the bytes whose cid and verifiedWith its index entry records", async () => {
        const { deps, built, key } = setup({ [id(ME)]: {}, [id(A)]: { verifiedWith: "zOther" } })
        const out = await buildSummary(ME, deps)
        for (const record of out!.records) {
            const repo = built.get(id(record.did))!
            expect(record.car).toEqual(repo.car)
            expect(record.cid).toBe(repo.recordCids["app.example.thing/self"])
        }
        expect(out!.index.records.map((r) => r.verifiedWith)).toEqual(["zOther", key.multikey])
        expect(out!.index.records.map((r) => r.cid)).toEqual(out!.records.map((r) => r.cid))
        for (const entry of out!.index.records) expect(entry).not.toHaveProperty("car")
    })
})

describe("diffSummaryIndex", () => {
    const entry = (did: string, cid = "c1", verifiedWith = "k1") => ({
        did,
        collection: "app.example.thing",
        rkey: "self",
        cid,
        verifiedWith,
    })
    const g = (n = 0): GraphReadResponse => ({
        did: "did:plc:me",
        following: n ? [{ did: "did:plc:a", rkey: `r${n}`, mutual: false }] : [],
        followers: [],
    })
    const idx = (records: ReturnType<typeof entry>[], graph = g()): SummaryIndex => ({ graph, records })

    it("with no base, everything changed and full is set", () => {
        const current = idx([entry("did:plc:a"), entry("did:plc:b")])
        expect(diffSummaryIndex(null, current)).toEqual({
            full: true,
            graphChanged: true,
            changed: current.records,
            removed: [],
        })
    })

    it("an unchanged summary yields nothing changed and graphChanged false", () => {
        const base = idx([entry("did:plc:a")], g(1))
        const current = idx([entry("did:plc:a")], g(1))
        expect(diffSummaryIndex(base, current)).toEqual({
            full: false,
            graphChanged: false,
            changed: [],
            removed: [],
        })
    })

    it("a changed graph is graphChanged", () => {
        expect(diffSummaryIndex(idx([], g(1)), idx([], g(2))).graphChanged).toBe(true)
    })

    it("a record whose CID changed is changed", () => {
        const out = diffSummaryIndex(idx([entry("did:plc:a", "c1")]), idx([entry("did:plc:a", "c2")]))
        expect(out.changed).toEqual([entry("did:plc:a", "c2")])
        expect(out.removed).toEqual([])
    })

    it("a record whose verifiedWith changed with the same CID is changed", () => {
        const out = diffSummaryIndex(
            idx([entry("did:plc:a", "c1", "k1")]),
            idx([entry("did:plc:a", "c1", "k2")])
        )
        expect(out.changed).toEqual([entry("did:plc:a", "c1", "k2")])
    })

    it("an added record is changed", () => {
        const out = diffSummaryIndex(idx([entry("did:plc:a")]), idx([entry("did:plc:a"), entry("did:plc:b")]))
        expect(out.changed).toEqual([entry("did:plc:b")])
    })

    it("a record no longer in the summary, or no longer verified, is removed", () => {
        const out = diffSummaryIndex(
            idx([entry("did:plc:a"), entry("did:plc:b")]),
            idx([entry("did:plc:a")])
        )
        expect(out.removed).toEqual([
            { did: "did:plc:b", collection: "app.example.thing", rkey: "self" },
        ])
        expect(out.changed).toEqual([])
    })
})

describe("summary read", () => {
    const COLLECTION = "app.example.thing"
    const WATCHED = [{ collection: COLLECTION, rkey: "self" }]
    const OWNER = "did:plc:alice0000000000000000"
    const OTHER_OWNER = "did:plc:bob00000000000000000000"
    const PEER = "did:plc:peer0000000000000000000"
    const URL_BASE = "https://relay.example/pmr/v1/summary"
    const T0 = 1_760_000_000

    function summaryWorld() {
        const registrations = new Map<string, RegistrationFields>()
        const challenges = (() => {
            const rows = new Map<string, string>()
            return {
                async mint(c: string, boundTo: string) {
                    rows.set(c, boundTo)
                },
                async consume(c: string) {
                    const v = rows.get(c)
                    if (v === undefined) return null
                    rows.delete(c)
                    return v
                },
            } as ChallengeStore
        })()
        const directory = {
            async resolve(did: string): Promise<Locator | null> {
                return registrations.has(did) ? `loc:${did}` : null
            },
            async create(did: string, registration: RegistrationFields): Promise<Locator> {
                if (!registrations.has(did)) registrations.set(did, registration)
                return `loc:${did}`
            },
        } as unknown as Directory

        // The served-state store, as the PMRStore contract describes it.
        const served = new Map<string, { token: string; index: SummaryIndex }[]>()
        const puts: { locator: string; token: string }[] = []
        const store = (locator: Locator): PMRStore =>
            ({
                load: async () => registrations.get(locator.slice(4)) ?? null,
                async putSummaryIndex(token: string, index: SummaryIndex) {
                    puts.push({ locator, token })
                    const list = (served.get(locator) ?? []).filter((e) => e.token !== token)
                    list.push({ token, index })
                    served.set(locator, list.slice(-SUMMARY_TOKENS_KEPT))
                },
                async getSummaryIndex(token: string) {
                    return served.get(locator)?.find((e) => e.token === token)?.index ?? null
                },
            }) as unknown as PMRStore

        // What the monitor holds: a record per DID at a version; absent unless set.
        const versions = new Map<string, number>()
        const key = makeKey()
        const projections = new Map<string, GraphReadResponse>()
        const reads: string[] = []
        const cars = new Map<string, Uint8Array>()
        const records: RecordSnapshotStore = {
            async get(did, collection, rkey) {
                const id = `${did}|${collection}/${rkey}`
                reads.push(id)
                const version = versions.get(did)
                if (version === undefined) return null
                const cacheKey = `${id}@${version}`
                if (!cars.has(cacheKey)) {
                    cars.set(
                        cacheKey,
                        buildRepoCar({
                            did,
                            key,
                            records: { [`${collection}/${rkey}`]: { $type: collection, did, version } },
                        }).car
                    )
                }
                return { car: cars.get(cacheKey)!, freshAtMs: 0, verifiedWith: key.multikey }
            },
        }
        const edge = (did: string): GraphReadResponse["following"][number] => ({
            did,
            rkey: "r1",
            mutual: false,
        })
        projections.set(OWNER, { did: OWNER, following: [edge(PEER)], followers: [] })
        projections.set(OTHER_OWNER, { did: OTHER_OWNER, following: [], followers: [] })
        versions.set(OWNER, 1)
        versions.set(OTHER_OWNER, 1)
        versions.set(PEER, 1)

        let n = 0
        const deps: OwnerDeps & SummaryDeps & { randomBytes: (n: number) => Uint8Array; nowMs: () => number } = {
            challenges,
            directory,
            resolveLocator: (did) => directory.resolve(did),
            store,
            nowSeconds: T0,
            discardWindowSeconds: 3600,
            projections: { get: async (did) => projections.get(did) ?? null },
            records,
            watched: WATCHED,
            randomBytes: (len) => {
                n += 1
                const bytes = new Uint8Array(len)
                new DataView(bytes.buffer).setUint32(0, n)
                return bytes
            },
            nowMs: () => T0 * 1000 + n,
        }
        return { deps, registrations, directory, challenges, versions, projections, served, puts, reads }
    }

    async function owner(w: ReturnType<typeof summaryWorld>, did: string) {
        const secretKey = ed25519.utils.randomSecretKey()
        await w.directory.create(did, {
            did,
            anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(secretKey) }),
            lastActive: T0,
        })
        return async (since?: string): Promise<Response> => {
            const c = `chal-${Math.random().toString(36).slice(2)}`
            await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
            const url = since === undefined ? URL_BASE : `${URL_BASE}?since=${encodeURIComponent(since)}`
            const parts = signRequest({ method: "GET", url, nonce: c, keyid: "t", secretKey })
            return handleSummaryRead(new Request(url, { method: "GET", headers: parts.headers }), w.deps)
        }
    }
    const read = async (res: Response) => decodeSummaryDelta(new Uint8Array(await res.arrayBuffer()))
    const dids = (d: { records: { did: string }[] }) => d.records.map((r) => r.did).sort()

    it("an unauthenticated read is 401", async () => {
        const w = summaryWorld()
        const res = await handleSummaryRead(new Request(URL_BASE), w.deps)
        expect(res.status).toBe(401)
        expect(w.reads).toEqual([])
    })

    it("a read with no since returns the full summary and a token", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const res = await get()
        expect(res.status).toBe(200)
        expect(res.headers.get("cache-control")).toBe("no-store")
        const delta = await read(res)
        expect(delta.full).toBe(true)
        expect(delta.token).not.toBe("")
        expect(delta.graph).toEqual(w.projections.get(OWNER))
        expect(dids(delta)).toEqual([OWNER, PEER].sort())
    })

    it("a full delta has removed empty", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        // A token no longer held is a full read, whatever the client held before.
        const delta = await read(await get("unknown-token"))
        expect(first.removed).toEqual([])
        expect(delta.full).toBe(true)
        expect(delta.removed).toEqual([])
    })

    it("the CARs served are the bytes read when building the index stored under the token", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const delta = await read(await get())
        const stored = (await w.deps.store(`loc:${OWNER}`).getSummaryIndex(delta.token))!
        expect(stored.records.map((e) => e.cid).sort()).toEqual(delta.records.map((r) => r.cid).sort())
        for (const r of delta.records) {
            expect(readRecordFromCar(r.car, r.collection, r.rkey)!.cid).toBe(r.cid)
        }
        // each record was read once for the whole response
        expect(new Set(w.reads).size).toBe(w.reads.length)
    })

    it("a read with nothing changed since the named state returns that token and stores nothing new", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const second = await read(await get(first.token))
        expect(second).toEqual({
            token: first.token,
            full: false,
            graph: null,
            records: [],
            removed: [],
            more: false,
            truncated: false,
        })
        expect(new Set(w.puts.map((p) => p.token))).toEqual(new Set([first.token]))
    })

    it("returning a named token unchanged makes it the most recent, so other reads do not drop it first", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const t1 = (await read(await get())).token
        const tokens = [t1]
        for (let v = 2; v <= SUMMARY_TOKENS_KEPT; v++) {
            w.versions.set(PEER, v)
            tokens.push((await read(await get(tokens[tokens.length - 1]))).token)
        }
        // the state at t1 recurs: naming t1 is unchanged, and refreshes it
        w.versions.set(PEER, 1)
        const again = await read(await get(t1))
        expect(again.token).toBe(t1)
        expect(again.records).toEqual([])
        w.versions.set(PEER, 99)
        await read(await get(t1)) // a new state evicts the oldest, which is no longer t1
        const held = w.served.get(`loc:${OWNER}`)!.map((e) => e.token)
        expect(held).toContain(t1)
        expect(held).not.toContain(tokens[1])
    })

    it("a read naming a served token returns only what changed since that state, CARs only for changed records", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        w.versions.set(PEER, 2)
        const delta = await read(await get(first.token))
        expect(delta.full).toBe(false)
        expect(delta.token).not.toBe(first.token)
        expect(delta.graph).toBeNull()
        expect(dids(delta)).toEqual([PEER])
        expect(delta.removed).toEqual([])
    })

    it("a changed graph is sent when it changed", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const next = { ...w.projections.get(OWNER)!, followers: [{ did: PEER, rkey: "r9", mutual: true }] }
        w.projections.set(OWNER, next)
        const delta = await read(await get(first.token))
        expect(delta.graph).toEqual(next)
        expect(delta.records).toEqual([])
        // a graph change is a new state: a client still naming the old token must see it too
        expect(delta.token).not.toBe(first.token)
        expect((await read(await get(first.token))).graph).toEqual(next)
    })

    it("a record added in one served state and removed later is in removed for a client naming that state", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        w.versions.delete(PEER)
        const t1 = await read(await get())
        expect(dids(t1)).toEqual([OWNER])
        w.versions.set(PEER, 1)
        const t2 = await read(await get(t1.token))
        expect(dids(t2)).toEqual([PEER])
        w.versions.delete(PEER)
        const t3 = await read(await get(t2.token))
        expect(t3.removed).toEqual([{ did: PEER, collection: COLLECTION, rkey: "self" }])
        // a removal is a new state: a client still naming t2 must see it again
        expect(t3.token).not.toBe(t2.token)
        expect((await read(await get(t2.token))).removed).toEqual(t3.removed)
        // a client still at t1 never held the record, so it has nothing to remove
        const fromT1 = await read(await get(t1.token))
        expect(fromT1.removed).toEqual([])
        expect(fromT1.records).toEqual([])
    })

    it("a read naming an unknown or dropped token returns the full summary", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        expect((await read(await get("never-served"))).full).toBe(true)
        const first = await read(await get())
        let token = first.token
        for (let v = 2; v <= SUMMARY_TOKENS_KEPT + 1; v++) {
            w.versions.set(PEER, v)
            token = (await read(await get(token))).token
        }
        expect((await read(await get(first.token))).full).toBe(true)
    })

    it("two clients naming different tokens each get the delta from their own state", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const t1 = await read(await get())
        w.versions.set(PEER, 2)
        const t2 = await read(await get(t1.token))
        w.versions.set(OWNER, 2)
        const fromT1 = await read(await get(t1.token))
        const fromT2 = await read(await get(t2.token))
        expect(dids(fromT1)).toEqual([OWNER, PEER].sort())
        expect(dids(fromT2)).toEqual([OWNER])
    })

    it("only the last SUMMARY_TOKENS_KEPT served states can be named", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        const tokens = [(await read(await get())).token]
        for (let v = 2; v <= SUMMARY_TOKENS_KEPT + 1; v++) {
            w.versions.set(PEER, v)
            tokens.push((await read(await get(tokens[tokens.length - 1]))).token)
        }
        const held = new Set(w.served.get(`loc:${OWNER}`)!.map((e) => e.token))
        expect(held.size).toBe(SUMMARY_TOKENS_KEPT)
        expect(held.has(tokens[0])).toBe(false)
        for (const t of tokens.slice(1)) expect(held.has(t)).toBe(true)
    })

    it("an owner with no projection yet is 409 with Retry-After", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        w.projections.delete(OWNER)
        const res = await get()
        expect(res.status).toBe(409)
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
        expect(w.puts).toEqual([])
    })

    it("one owner's tokens are unknown to another owner", async () => {
        const w = summaryWorld()
        const getA = await owner(w, OWNER)
        const getB = await owner(w, OTHER_OWNER)
        const a = await read(await getA())
        const b = await read(await getB(a.token))
        expect(b.full).toBe(true)
        expect(b.token).not.toBe(a.token)
    })
})

describe("summary codec", () => {
    const delta: SummaryDelta = {
        token: "tok",
        full: false,
        more: false,
        truncated: false,
        graph: { did: "did:plc:me", following: [{ did: "did:plc:a", rkey: "r1", mutual: true }], followers: [] },
        records: [
            {
                did: "did:plc:a",
                collection: "app.example.thing",
                rkey: "self",
                cid: "bafy",
                verifiedWith: "zKey",
                car: Uint8Array.of(1, 2, 3),
            },
        ],
        removed: [{ did: "did:plc:b", collection: "app.example.thing", rkey: "self" }],
    }

    it("a delta round-trips through encode and decode", () => {
        expect(decodeSummaryDelta(encodeSummaryDelta(delta))).toEqual(delta)
        const unchangedGraph = { ...delta, graph: null, records: [], removed: [] }
        expect(decodeSummaryDelta(encodeSummaryDelta(unchangedGraph))).toEqual(unchangedGraph)
    })

    it("decode ignores unknown keys", () => {
        const bytes = encodeCose(
            new Map<string, CoseValue>([
                [SUMMARY_DELTA_KEYS.token, "t"],
                [SUMMARY_DELTA_KEYS.full, true],
                [SUMMARY_DELTA_KEYS.graph, null],
                [
                    SUMMARY_DELTA_KEYS.records,
                    [
                        new Map<string, CoseValue>([
                            [SUMMARY_RECORD_KEYS.did, "d"],
                            [SUMMARY_RECORD_KEYS.collection, "c"],
                            [SUMMARY_RECORD_KEYS.rkey, "k"],
                            [SUMMARY_RECORD_KEYS.cid, "i"],
                            [SUMMARY_RECORD_KEYS.verifiedWith, "v"],
                            [SUMMARY_RECORD_KEYS.car, Uint8Array.of(9)],
                            ["zz", 1],
                        ]),
                    ],
                ],
                [SUMMARY_DELTA_KEYS.removed, []],
                ["zz", "extra"],
            ])
        )
        expect(decodeSummaryDelta(bytes).records).toHaveLength(1)
    })

    it("decode rejects a body missing a required field", () => {
        const base = (): Map<string, CoseValue> =>
            new Map<string, CoseValue>([
                [SUMMARY_DELTA_KEYS.token, "t"],
                [SUMMARY_DELTA_KEYS.full, true],
                [SUMMARY_DELTA_KEYS.graph, null],
                [SUMMARY_DELTA_KEYS.records, []],
                [SUMMARY_DELTA_KEYS.removed, []],
            ])
        expect(decodeSummaryDelta(encodeCose(base())).token).toBe("t")
        const optional: string[] = [SUMMARY_DELTA_KEYS.more, SUMMARY_DELTA_KEYS.truncated]
        for (const key of Object.values(SUMMARY_DELTA_KEYS)) {
            if (optional.includes(key)) continue
            const m = base()
            m.delete(key)
            expect(() => decodeSummaryDelta(encodeCose(m))).toThrow()
        }
        const noCar = base()
        noCar.set(SUMMARY_DELTA_KEYS.records, [
            new Map<string, CoseValue>([
                [SUMMARY_RECORD_KEYS.did, "d"],
                [SUMMARY_RECORD_KEYS.collection, "c"],
                [SUMMARY_RECORD_KEYS.rkey, "k"],
                [SUMMARY_RECORD_KEYS.cid, "i"],
                [SUMMARY_RECORD_KEYS.verifiedWith, "v"],
            ]),
        ])
        expect(() => decodeSummaryDelta(encodeCose(noCar))).toThrow()
    })

    it("SUMMARY_DELTA_KEYS and SUMMARY_RECORD_KEYS each give every field a distinct key", () => {
        for (const keys of [SUMMARY_DELTA_KEYS, SUMMARY_RECORD_KEYS]) {
            const values = Object.values(keys)
            expect(new Set(values).size).toBe(values.length)
        }
    })
})
