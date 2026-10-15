/**
 * The indices the summary route keeps per token survive any summary size the
 * contact cap allows, and a paged sync holds one slot however many pages it
 * takes. (The route's own paging is in core's summary specs, against the
 * same storage contract.)
 */
import { env } from "cloudflare:test"
import { SUMMARY_TOKENS_KEPT, type SummaryIndex } from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`summary-paging-${counter}`))
}

const small = (n: number, more = false): SummaryIndex => ({
    graph: { did: "did:plc:me", following: [], followers: [] },
    records: [
        {
            did: "did:plc:a",
            collection: "app.example.thing",
            rkey: "self",
            cid: `cid-${n}`,
            verifiedWith: "zKey",
        },
    ],
    ...(more ? { more: true } : {}),
})

/** About 1.7 KB of entries per hundred: well past one storage value at this size. */
function large(records: number, edges: number): SummaryIndex {
    const did = (prefix: string, i: number) => `did:plc:${prefix}${String(i).padStart(8, "0")}${"x".repeat(1000)}`
    return {
        graph: {
            did: "did:plc:me",
            following: Array.from({ length: edges }, (_, i) => ({ did: did("f", i), rkey: `r${i}`, mutual: i % 2 === 0 })),
            followers: Array.from({ length: edges }, (_, i) => ({ did: did("g", i), rkey: `r${i}`, mutual: false })),
        },
        records: Array.from({ length: records }, (_, i) => ({
            did: did("c", i),
            collection: "app.example.thing",
            rkey: "self",
            cid: `bafyrei${i}`,
            verifiedWith: "zKey",
        })),
        more: true,
    }
}

describe("summary route paging storage", () => {
    it("a page read since a more token replaces that token's slot, so paging does not evict other tokens", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < SUMMARY_TOKENS_KEPT - 1; i++) {
                await pmr.putSummaryIndex(`other${i}`, small(i), 1000 + i)
            }
            await pmr.putSummaryIndex("p1", small(10, true), 2000)
            await pmr.putSummaryIndex("p2", small(11, true), 2001, "p1")
            await pmr.putSummaryIndex("p3", small(12), 2002, "p2")
            expect(await pmr.getSummaryIndex("p1")).toBeNull()
            expect(await pmr.getSummaryIndex("p2")).toBeNull()
            expect(await pmr.getSummaryIndex("p3")).toEqual(small(12))
            for (let i = 0; i < SUMMARY_TOKENS_KEPT - 1; i++) {
                expect(await pmr.getSummaryIndex(`other${i}`)).toEqual(small(i))
            }
        })
    })

    it("a page read since a final token keeps it, for other devices", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.putSummaryIndex("final", small(1), 1000)
            await pmr.putSummaryIndex("next", small(2), 1001)
            expect(await pmr.getSummaryIndex("final")).toEqual(small(1))
            expect(await pmr.getSummaryIndex("next")).toEqual(small(2))
        })
    })
})

describe("PMRObject summary index storage", () => {
    it("an index larger than one 2 MB storage value round-trips", async () => {
        const index = large(1_500, 1_500)
        expect(JSON.stringify(index).length).toBeGreaterThan(2 * 1024 * 1024)
        await inPMR(freshStub(), async (pmr) => {
            await pmr.putSummaryIndex("big", index, 1000)
            expect(await pmr.getSummaryIndex("big")).toEqual(index)
            const stored = await (pmr as unknown as { db: DurableObjectStorage }).db.list({
                prefix: "summaryPart:big:",
            })
            expect(stored.size).toBeGreaterThan(1)
            for (const part of stored.values()) {
                expect(JSON.stringify(part).length).toBeLessThan(1_100_000)
            }
        })
    })

    it("dropping a token deletes every part of its index", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const db = (pmr as unknown as { db: DurableObjectStorage }).db
            await pmr.putSummaryIndex("old", large(500, 500), 1000)
            expect((await db.list({ prefix: "summaryPart:old:" })).size).toBeGreaterThan(1)
            for (let i = 0; i < SUMMARY_TOKENS_KEPT; i++) {
                await pmr.putSummaryIndex(`n${i}`, small(i), 2000 + i)
            }
            expect(await pmr.getSummaryIndex("old")).toBeNull()
            expect((await db.list({ prefix: "summaryPart:old:" })).size).toBe(0)
            expect((await db.list({ prefix: "summary:old" })).size).toBe(0)
        })
    })

    it("a replaced token's parts are deleted with it", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const db = (pmr as unknown as { db: DurableObjectStorage }).db
            await pmr.putSummaryIndex("p1", large(500, 500), 1000)
            await pmr.putSummaryIndex("p2", small(1), 1001, "p1")
            expect((await db.list({ prefix: "summaryPart:p1:" })).size).toBe(0)
        })
    })

    it("re-storing a token with a smaller index leaves none of its old parts", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const db = (pmr as unknown as { db: DurableObjectStorage }).db
            await pmr.putSummaryIndex("t", large(500, 500), 1000)
            await pmr.putSummaryIndex("t", small(1), 1001)
            expect(await pmr.getSummaryIndex("t")).toEqual(small(1))
            expect((await db.list({ prefix: "summaryPart:t:" })).size).toBe(1)
        })
    })

    it("a client-named token cannot overwrite or address another token's part", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const big = large(10, 10)
            await pmr.putSummaryIndex("t", big, 1000)
            // "t:0" would be the key of t's first part if parts shared the header prefix.
            await pmr.putSummaryIndex("t:0", small(1), 1001)
            expect(await pmr.getSummaryIndex("t")).toEqual(big)
            expect(await pmr.getSummaryIndex("t:0")).toEqual(small(1))
        })
    })
})
