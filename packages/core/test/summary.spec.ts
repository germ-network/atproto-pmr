/**
 * The owner's summary carries the full CARs of their graph's records. A read
 * names the state the client holds and gets only what changed since; a client
 * that names nothing, or a state no longer held, gets everything, so no lost
 * response, lost state or second device leaves a client wrong.
 */
import { describe, expect, it } from "vitest"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import type { GraphReadResponse } from "../src/read-api"
import {
    buildSummary,
    diffSummaryIndex,
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
    it.todo("an unauthenticated read is 401")
    it.todo("a read with no since returns the full summary and a token")
    it.todo("a full delta has removed empty")
    it.todo("the CARs served are the bytes read when building the index stored under the token")
    it.todo("a read with nothing changed since the named state returns that token and stores nothing new")
    it.todo("returning a named token unchanged makes it the most recent, so other reads do not drop it first")
    it.todo("a read naming a served token returns only what changed since that state, CARs only for changed records")
    it.todo("a record added in one served state and removed later is in removed for a client naming that state")
    it.todo("a read naming an unknown or dropped token returns the full summary")
    it.todo("two clients naming different tokens each get the delta from their own state")
    it.todo("only the last SUMMARY_TOKENS_KEPT served states can be named")
    it.todo("an owner with no projection yet is 409 with Retry-After")
    it.todo("one owner's tokens are unknown to another owner")
})

describe("summary codec", () => {
    it.todo("a delta round-trips through encode and decode")
    it.todo("decode ignores unknown keys")
    it.todo("SUMMARY_DELTA_KEYS and SUMMARY_RECORD_KEYS each give every field a distinct key")
})
