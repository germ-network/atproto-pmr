/** The summary baseline the PMR object stores keeps each verdict's mutual bit. */
import { env } from "cloudflare:test"
import { diffSummaryIndex, type SummaryIndex } from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import type { PMREnv } from "../src/env"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

const index: SummaryIndex = {
    owner: "did:plc:me",
    ownBlocks: [],
    records: [],
    verdicts: [
        { did: "did:plc:a", verdict: { verdict: "yes", via: ["open"] }, mutual: true },
        { did: "did:plc:b", verdict: { verdict: "no", why: ["blocked"] }, mutual: false },
    ],
}

describe("stored summary mutual bits", () => {
    it("round-trips an index whose verdicts carry mutual true and false", async () => {
        const stub = testEnv.pmrs.get(testEnv.pmrs.idFromName("summary-mutual-roundtrip"))
        await inPMR(stub, async (pmr) => {
            await pmr.putSummaryIndex("t1", index, 1000)
            const read = (await pmr.getSummaryIndex("t1"))!
            expect(read).toEqual(index)
            expect(read.verdicts.map((v) => v.mutual)).toEqual([true, false])
        })
    })

    it("a stored baseline from before mutual bits re-sends every verdict entry once, then settles", async () => {
        const stub = testEnv.pmrs.get(testEnv.pmrs.idFromName("summary-mutual-legacy"))
        const legacy = {
            ...index,
            verdicts: index.verdicts.map(({ did, verdict }) => ({ did, verdict })),
        } as unknown as SummaryIndex
        await inPMR(stub, async (pmr) => {
            await pmr.putSummaryIndex("legacy", legacy, 1000)
            const held = (await pmr.getSummaryIndex("legacy"))!
            expect(held.verdicts.every((v) => v.mutual === undefined)).toBe(true)
            expect(diffSummaryIndex(held, index).verdicts).toEqual(index.verdicts)

            await pmr.putSummaryIndex("next", index, 2000)
            const settled = (await pmr.getSummaryIndex("next"))!
            expect(diffSummaryIndex(settled, index).verdicts).toEqual([])
        })
    })
})
