/**
 * The pool listing tells the device why the relay pooled each sender, so the
 * device judges with the relay's reason instead of recomputing it.
 */
import { describe, expect, it } from "vitest"
import { handlePoolList } from "../src/owner/endpoints"
import type { PoolSender } from "../src/storage"
import { cborMap, ownerWorld } from "./owner-harness"

async function listing(senders: PoolSender[]) {
    const w = await ownerWorld({ poolSenders: async () => senders })
    const response = await handlePoolList(await w.request("/pmr/v1/pool"), w.deps)
    expect(response.status).toBe(200)
    return (await cborMap(response)).get("p") as Map<string, unknown>[]
}

describe("GET /pmr/v1/pool verdicts", () => {
    it("an entry with a verdict carries v (no | unknown) and r (reason codes, in order)", async () => {
        const [no, unknown] = await listing([
            { did: "did:plc:a", count: 1, verdict: { verdict: "no", why: ["not-admitted"] } },
            { did: "did:plc:b", count: 2, verdict: { verdict: "unknown", why: ["graph-incomplete", "block-unknown"] } },
        ])
        expect([no!.get("v"), no!.get("r")]).toEqual(["no", ["not-admitted"]])
        expect([unknown!.get("v"), unknown!.get("r")]).toEqual(["unknown", ["graph-incomplete", "block-unknown"]])
    })

    it("an entry pooled without a verdict carries neither v nor r", async () => {
        const [entry] = await listing([{ did: "did:plc:a", count: 1 }])
        expect(entry!.has("v")).toBe(false)
        expect(entry!.has("r")).toBe(false)
    })

    it("keeps did and n unchanged", async () => {
        const [entry] = await listing([
            { did: "did:plc:a", count: 3, verdict: { verdict: "no", why: [] } },
        ])
        expect(entry!.get("did")).toBe("did:plc:a")
        expect(entry!.get("n")).toBe(3)
    })
})
