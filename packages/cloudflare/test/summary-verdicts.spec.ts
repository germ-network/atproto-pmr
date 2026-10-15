/** The summary baseline the PMR object stores keeps the verdicts it delivered. */
import { env } from "cloudflare:test"
import type { SummaryIndex } from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import type { PMREnv } from "../src/env"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

describe("stored summary verdicts", () => {
    it("round-trips an index whose verdicts span several stored parts", async () => {
        const did = (i: number) => `did:plc:${String(i).padStart(6, "0")}${"x".repeat(2000)}`
        const verdicts: SummaryIndex["verdicts"] = Array.from({ length: 1_200 }, (_, i) => ({
            did: did(i),
            verdict: i % 2 === 0 ? { verdict: "yes", via: ["open"] } : { verdict: "no", why: ["blocked"] },
        }))
        // Past one 1,000,000-character part, so the verdicts are split.
        expect(JSON.stringify(verdicts).length).toBeGreaterThan(2_000_000)
        const index: SummaryIndex = { owner: "did:plc:me", ownBlocks: [], records: [], verdicts }
        const stub = testEnv.pmrs.get(testEnv.pmrs.idFromName("summary-verdicts"))
        await inPMR(stub, async (pmr) => {
            await pmr.putSummaryIndex("t1", index, 1000)
            expect(await pmr.getSummaryIndex("t1")).toEqual(index)
        })
    })
})
