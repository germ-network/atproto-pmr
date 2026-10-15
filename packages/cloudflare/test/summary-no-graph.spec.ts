/** The summary baseline the PMR object stores holds no follow graph. */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { SummaryIndex } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

const testEnv = env as unknown as PMREnv<PMRObject>

describe("stored summary baseline", () => {
    it("round-trips an index with owner, ownBlocks and records, storing no following/followers parts", async () => {
        const stub = testEnv.pmrs.get(testEnv.pmrs.idFromName("no-graph-baseline"))
        const index: SummaryIndex = {
            owner: "did:plc:me",
            ownBlocks: [{ did: "did:plc:x", rkey: "3k1" }],
            records: [
                { did: "did:plc:a", collection: "app.example.thing", rkey: "self", cid: "bafy", verifiedWith: "zKey" },
            ],
        }
        await stub.putSummaryIndex("tok", index, 1)
        expect(await stub.getSummaryIndex("tok")).toEqual(index)
        const stored = await runInDurableObject(stub, async (_obj, state) => [
            ...(await state.storage.list({ prefix: "summaryPart:" })).values(),
        ])
        expect((stored as { field: string }[]).map((p) => p.field).sort()).toEqual(["ownBlocks", "records"])
    })
})
