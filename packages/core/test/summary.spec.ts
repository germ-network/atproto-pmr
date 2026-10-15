/**
 * The owner's summary carries the full CARs of their contacts' records. A read
 * names the state the client holds and gets only what changed since; a client
 * that names nothing, or a state no longer held, gets everything, so no lost
 * response, lost state or second device leaves a client wrong.
 */
import { describe, expect, it } from "vitest"
import { encodeCose, type CoseValue } from "../src/cose/cbor"
import { handleSummaryRead } from "../src/owner/endpoints"
import { readRecordFromCar } from "../src/repo-proof"
import {
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    SUMMARY_DELTA_KEYS,
    SUMMARY_MAX_RECORDS,
    SUMMARY_RECORD_KEYS,
    SUMMARY_TOKENS_KEPT,
    type SummaryDelta,
    type SummaryIndex,
} from "../src/summary"
import {
    COLLECTION,
    dids,
    OTHER_OWNER,
    owner,
    OWNER,
    PEER,
    read,
    summaryWorld,
    URL_BASE,
} from "./fixtures/summary-world"

describe("diffSummaryIndex", () => {
    const entry = (did: string, cid = "c1", verifiedWith = "k1") => ({
        did,
        collection: "app.example.thing",
        rkey: "self",
        cid,
        verifiedWith,
    })
    const idx = (records: ReturnType<typeof entry>[]): SummaryIndex => ({
        owner: "did:plc:me",
        ownBlocks: [],
        records,
        verdicts: [],
    })

    it("with no base, everything changed and full is set", () => {
        const current = idx([entry("did:plc:a"), entry("did:plc:b")])
        expect(diffSummaryIndex(null, current)).toEqual({
            full: true,
            blocksChanged: true,
            changed: current.records,
            removed: [],
            verdicts: [],
            droppedVerdicts: [],
        })
    })

    it("an unchanged summary yields nothing changed", () => {
        const base = idx([entry("did:plc:a")])
        const current = idx([entry("did:plc:a")])
        expect(diffSummaryIndex(base, current)).toEqual({
            full: false,
            blocksChanged: false,
            changed: [],
            removed: [],
            verdicts: [],
            droppedVerdicts: [],
        })
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
            ownBlocks: null,
            records: [],
            removed: [],
            verdicts: [],
            droppedVerdicts: [],
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
        expect(dids(delta)).toEqual([PEER])
        expect(delta.removed).toEqual([])
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

    describe("own blocks", () => {
        const heldTokens = (w: ReturnType<typeof summaryWorld>) =>
            (w.served.get(`loc:${OWNER}`) ?? []).map((e) => e.token)

        it("a full read carries the owner's blocks, and an unchanged read sends b null under the same token", async () => {
            const w = summaryWorld()
            w.blocks.set(OWNER, [{ blocker: OWNER, rkey: "3k1", subject: "did:plc:x" }])
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first.ownBlocks).toEqual([{ did: "did:plc:x", rkey: "3k1" }])
            const second = await read(await get(first.token))
            expect(second.ownBlocks).toBeNull()
            expect(second.token).toBe(first.token)
        })

        it("a change to blocks alone issues a new token with the whole list", async () => {
            const w = summaryWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first.ownBlocks).toEqual([])
            w.blocks.set(OWNER, [{ blocker: OWNER, rkey: "3k1", subject: "did:plc:x" }])
            const second = await read(await get(first.token))
            expect(second.token).not.toBe(first.token)
            expect(second).toMatchObject({ full: false, records: [], removed: [] })
            expect(second.ownBlocks).toEqual([{ did: "did:plc:x", rkey: "3k1" }])
            const third = await read(await get(second.token))
            expect(third.ownBlocks).toBeNull()
            expect(third.token).toBe(second.token)
        })

        it("sorts the list by rkey, so an unordered source does not resend it on every poll", async () => {
            const w = summaryWorld()
            w.blocks.set(OWNER, [
                { blocker: OWNER, rkey: "3k2", subject: "did:plc:y" },
                { blocker: OWNER, rkey: "3k1", subject: "did:plc:x" },
            ])
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first.ownBlocks!.map((b) => b.rkey)).toEqual(["3k1", "3k2"])
            w.blocks.set(OWNER, [...w.blocks.get(OWNER)!].reverse())
            expect((await read(await get(first.token))).ownBlocks).toBeNull()
        })

        it("a paged sync delivers the list on its first page and a later change on the next", async () => {
            const w = summaryWorld()
            w.deps.pageRecords = 1
            w.blocks.set(OWNER, [{ blocker: OWNER, rkey: "3k1", subject: "did:plc:x" }])
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first).toMatchObject({ full: true, more: true })
            expect(first.ownBlocks).toEqual([{ did: "did:plc:x", rkey: "3k1" }])
            const second = await read(await get(first.token))
            expect(second.ownBlocks).toBeNull()
            w.blocks.set(OWNER, [])
            const third = await read(await get(second.token))
            expect(third.ownBlocks).toEqual([])
        })

        it("answers 503 with Retry-After when the blocks cannot be read, keeping the held states", async () => {
            const w = summaryWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            const held = heldTokens(w)
            w.blocksFail.add(OWNER)
            const res = await get(first.token)
            expect(res.status).toBe(503)
            expect(res.headers.get("Retry-After")).not.toBeNull()
            expect(heldTokens(w)).toEqual(held)
            w.blocksFail.delete(OWNER)
            expect((await read(await get(first.token))).token).toBe(first.token)
        })

        it("answers 409 when the owner's graph is not served, keeping the held states", async () => {
            const w = summaryWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            const held = heldTokens(w)
            w.notServed.add(OWNER)
            const res = await get(first.token)
            expect(res.status).toBe(409)
            expect(res.headers.get("Retry-After")).not.toBeNull()
            expect(heldTokens(w)).toEqual(held)
        })

        it("answers 409 + Retry-After when the owner's graph is not served (graph.ownGraph null)", async () => {
            const w = summaryWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            const held = heldTokens(w)
            w.ownGraphs.delete(OWNER)
            const res = await get(first.token)
            expect(res.status).toBe(409)
            expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
            expect(heldTokens(w)).toEqual(held)
        })

        it("answers 503 + Retry-After and leaves the stored baseline untouched when graph.ownGraph throws", async () => {
            const w = summaryWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            const held = heldTokens(w)
            w.graphFail.add(OWNER)
            const res = await get(first.token)
            expect(res.status).toBe(503)
            expect(res.headers.get("Retry-After")).not.toBeNull()
            expect(heldTokens(w)).toEqual(held)
            w.graphFail.delete(OWNER)
            expect((await read(await get(first.token))).token).toBe(first.token)
        })
    })

    it("an owner whose graph is not served yet is 409 with Retry-After", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        w.ownGraphs.delete(OWNER)
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

    describe("paging", () => {
        const peers = [1, 2, 3, 4].map((i) => `did:plc:page${i}00000000000000000`)
        function pagedWorld(pageRecords = 2) {
            const w = summaryWorld()
            const edge = (did: string) => ({ did, mutual: false })
            w.ownGraphs.set(OWNER, { did: OWNER, following: peers.map(edge), followers: [] })
            for (const p of peers) w.versions.set(p, 1)
            w.deps.pageRecords = pageRecords
            return w
        }

        it("a first read with more changes than a page returns full, more, and a token", async () => {
            const w = pagedWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first).toMatchObject({ full: true, more: true, truncated: false })
            expect(first.records).toHaveLength(2)
            expect(first.token).toBeTruthy()
        })

        it("reading since that token continues from what was delivered, not from current", async () => {
            const w = pagedWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            const second = await read(await get(first.token))
            expect(second).toMatchObject({ full: false, more: true })
            expect(second.records).toHaveLength(2)
            const third = await read(await get(second.token))
            expect(third).toMatchObject({ full: false, more: false })
            expect(third.records).toHaveLength(1)
            const all = [...first.records, ...second.records, ...third.records].map((r) => r.did)
            expect(new Set(all)).toEqual(new Set([OWNER, ...peers]))
            expect(all).toHaveLength(5)
        })

        it("reading since the last page's token with nothing new returns that token, unchanged", async () => {
            const w = pagedWorld(10)
            const get = await owner(w, OWNER)
            const only = await read(await get())
            expect(only.more).toBe(false)
            const again = await read(await get(only.token))
            expect(again).toMatchObject({ token: only.token, full: false, more: false, records: [] })
        })

        it("an unchanged poll on a token that left more set finishes it and clears more", async () => {
            const w = pagedWorld()
            const get = await owner(w, OWNER)
            const first = await read(await get())
            expect(first.records.map((r) => r.did).sort()).toEqual([OWNER, peers[0]!].sort())
            // What was left to deliver vanishes before the next read.
            for (const p of peers.slice(1)) w.versions.delete(p)
            const next = await read(await get(first.token))
            expect(next).toMatchObject({ token: first.token, more: false, records: [], removed: [] })
            const stored = [...w.served.values()][0]!.find((e) => e.token === first.token)!
            expect(stored.index.more).toBeUndefined()
        })

        it("a page that delivers nothing but has more left does not return the named token", async () => {
            const w = pagedWorld()
            for (const p of peers) w.versions.delete(p)
            const get = await owner(w, OWNER)
            const first = await read(await get())
            // The peers appear in the index but their records cannot be read.
            for (const p of peers) {
                w.versions.set(p, 1)
                w.unreadable.add(p)
            }
            w.deps.pageRecords = 1
            const next = await read(await get(first.token))
            expect(next).toMatchObject({ records: [], removed: [], more: true })
            expect(next.token).not.toBe(first.token)
        })

        it("an owner with more contacts than the cap allows gets truncated set", async () => {
            const w = pagedWorld()
            const many = Array.from({ length: SUMMARY_MAX_RECORDS + 1 }, (_, i) => ({
                did: `did:plc:many${String(i).padStart(6, "0")}`,
                mutual: false,
            }))
            w.ownGraphs.set(OWNER, { did: OWNER, following: many, followers: [] })
            const get = await owner(w, OWNER)
            expect((await read(await get())).truncated).toBe(true)
        })

        it("a page read since a more token replaces that token's slot, so paging does not evict other tokens", async () => {
            const w = pagedWorld()
            const get = await owner(w, OWNER)
            w.deps.pageRecords = 10
            const device = await read(await get())
            w.deps.pageRecords = 2
            const p1 = await read(await get())
            const p2 = await read(await get(p1.token))
            const p3 = await read(await get(p2.token))
            const held = [...w.served.values()][0]!.map((e) => e.token)
            expect(held).toContain(device.token)
            expect(held).toContain(p3.token)
            expect(held).not.toContain(p1.token)
            expect(held).not.toContain(p2.token)
        })

        it("a page read since a final token keeps it, for other devices", async () => {
            const w = pagedWorld(10)
            const get = await owner(w, OWNER)
            const final = await read(await get())
            w.versions.set(peers[0]!, 2)
            const next = await read(await get(final.token))
            expect(next.token).not.toBe(final.token)
            const held = [...w.served.values()][0]!.map((e) => e.token)
            expect(held).toEqual(expect.arrayContaining([final.token, next.token]))
        })
    })

})

describe("summary codec", () => {
    const delta: SummaryDelta = {
        token: "tok",
        full: false,
        more: false,
        truncated: false,
        ownBlocks: [{ did: "did:plc:x", rkey: "3k1" }],
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
        verdicts: [],
        droppedVerdicts: [],
    }

    it("a delta round-trips through encode and decode", () => {
        expect(decodeSummaryDelta(encodeSummaryDelta(delta))).toEqual(delta)
        const unchanged = { ...delta, ownBlocks: null, records: [], removed: [] }
        expect(decodeSummaryDelta(encodeSummaryDelta(unchanged))).toEqual(unchanged)
    })

    it("decode ignores unknown keys", () => {
        const bytes = encodeCose(
            new Map<string, CoseValue>([
                [SUMMARY_DELTA_KEYS.token, "t"],
                [SUMMARY_DELTA_KEYS.full, true],
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
                [SUMMARY_DELTA_KEYS.records, []],
                [SUMMARY_DELTA_KEYS.removed, []],
            ])
        expect(decodeSummaryDelta(encodeCose(base())).token).toBe("t")
        const optional: string[] = [
            SUMMARY_DELTA_KEYS.more,
            SUMMARY_DELTA_KEYS.truncated,
            SUMMARY_DELTA_KEYS.ownBlocks,
            SUMMARY_DELTA_KEYS.verdicts,
            SUMMARY_DELTA_KEYS.droppedVerdicts,
        ]
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
