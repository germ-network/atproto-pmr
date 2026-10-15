/**
 * The device can tell which relay blocks mirror Bsky, so it knows which
 * unblocks will hold and keeps them out of the block list it republishes.
 */
import { describe, expect, it } from "vitest"
import { handleBlockSet, handleBlocksList } from "../src/owner/endpoints"
import { cborMap, ownerWorld } from "./owner-harness"

describe("GET /pmr/v1/blocks sources", () => {
    it("b lists every blocked sender, as before", async () => {
        const w = await ownerWorld({
            listBlocked: async () => ["did:plc:a", "did:plc:b"],
            listBskyBlocked: async () => ["did:plc:b"],
        })
        const response = await handleBlocksList(await w.request("/pmr/v1/blocks"), w.deps)
        expect((await cborMap(response)).get("b")).toEqual(["did:plc:a", "did:plc:b"])
    })

    it("bs lists the senders whose block mirrors a Bsky block", async () => {
        const w = await ownerWorld({
            listBlocked: async () => ["did:plc:a", "did:plc:b"],
            listBskyBlocked: async () => ["did:plc:b"],
        })
        const response = await handleBlocksList(await w.request("/pmr/v1/blocks"), w.deps)
        expect((await cborMap(response)).get("bs")).toEqual(["did:plc:b"])
    })

    it("a device block request is a device-sourced block", async () => {
        const calls: unknown[][] = []
        const w = await ownerWorld({
            block: async (...args: unknown[]) => void calls.push(args),
        } as never)
        const response = await handleBlockSet(
            await w.request("/pmr/v1/blocks/did:plc:a", "PUT"),
            "did:plc:a",
            true,
            w.deps
        )
        expect(response.status).toBe(204)
        expect(calls).toEqual([["did:plc:a", 1_760_000_000, "device"]])
    })
})
