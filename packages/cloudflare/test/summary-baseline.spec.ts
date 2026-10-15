/**
 * Served summary states are private to the owner's registration and stored
 * one entry per token.
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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`summary-${counter}`))
}

const index = (n: number): SummaryIndex => ({
    graph: { did: "did:plc:me", following: [], followers: [] },
    ownBlocks: [],
    records: [
        {
            did: "did:plc:a",
            collection: "app.example.thing",
            rkey: "self",
            cid: `cid-${n}`,
            verifiedWith: "zKey",
        },
    ],
})

describe("summary index storage", () => {
    it("an index stored under a token reads back unchanged", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.putSummaryIndex("t1", index(1), 1000)
            expect(await pmr.getSummaryIndex("t1")).toEqual(index(1))
        })
    })

    it("a token never stored reads null", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.putSummaryIndex("t1", index(1), 1000)
            expect(await pmr.getSummaryIndex("other")).toBeNull()
        })
    })

    it("storing past SUMMARY_TOKENS_KEPT drops the oldest token only", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i <= SUMMARY_TOKENS_KEPT; i++) {
                await pmr.putSummaryIndex(`t${i}`, index(i), 1000 + i)
            }
            expect(await pmr.getSummaryIndex("t0")).toBeNull()
            for (let i = 1; i <= SUMMARY_TOKENS_KEPT; i++) {
                expect(await pmr.getSummaryIndex(`t${i}`)).toEqual(index(i))
            }
        })
    })

    it("storing a token again makes it the most recent, so it is dropped last", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < SUMMARY_TOKENS_KEPT; i++) {
                await pmr.putSummaryIndex(`t${i}`, index(i), 1000 + i)
            }
            await pmr.putSummaryIndex("t0", index(0), 2000)
            await pmr.putSummaryIndex("new", index(9), 3000)
            expect(await pmr.getSummaryIndex("t1")).toBeNull()
            expect(await pmr.getSummaryIndex("t0")).toEqual(index(0))
            expect(await pmr.getSummaryIndex("new")).toEqual(index(9))
        })
    })

    it("equal or regressing clock readings do not reorder what was served", async () => {
        for (const clock of [() => 1000, (i: number) => 1000 - i]) {
            await inPMR(freshStub(), async (pmr) => {
                // Written in reverse key order, so a tie falls back to the wrong end.
                const tokens = Array.from({ length: SUMMARY_TOKENS_KEPT + 1 }, (_, i) => `z${9 - i}`)
                for (const [i, token] of tokens.entries()) {
                    await pmr.putSummaryIndex(token, index(i), clock(i))
                }
                expect(await pmr.getSummaryIndex(tokens[0])).toBeNull()
                for (const token of tokens.slice(1)) {
                    expect(await pmr.getSummaryIndex(token)).not.toBeNull()
                }
            })
        }
    })

    it("a token too long to be a key reads null", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await pmr.getSummaryIndex("x".repeat(5000))).toBeNull()
        })
    })

    it("summary entries leave the registration and watch state alone, and those keys are not tokens", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: 5 })
            for (let i = 0; i <= SUMMARY_TOKENS_KEPT + 2; i++) {
                await pmr.putSummaryIndex(`t${i}`, index(i), 1000 + i)
            }
            expect(await pmr.readWatchState()).toEqual({ paused: true, lastCheckAt: 5 })
            for (const name of ["watch", "reg", "poolBytes", "summaryOrder"]) {
                expect(await pmr.getSummaryIndex(name)).toBeNull()
            }
        })
    })

    it("two registrations' tokens are independent", async () => {
        const a = freshStub()
        const b = freshStub()
        await inPMR(a, (pmr) => pmr.putSummaryIndex("shared", index(1), 1000))
        expect(await inPMR(b, (pmr) => pmr.getSummaryIndex("shared"))).toBeNull()
        await inPMR(b, (pmr) => pmr.putSummaryIndex("shared", index(2), 1000))
        expect(await inPMR(a, (pmr) => pmr.getSummaryIndex("shared"))).toEqual(index(1))
    })
})
