/**
 * The public graph projections are read back exactly as the projector wrote them.
 */
import { env } from "cloudflare:test"
import type { GraphReadResponse } from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import { kvGraphProjections } from "../src/graph-projection-store"

const projection = (did: string): GraphReadResponse => ({
    did,
    following: [{ did: "did:plc:a", rkey: "r1", mutual: true }],
    followers: [
        { did: "did:plc:a", rkey: "r3", mutual: true },
        { did: "did:plc:b", rkey: "r2", mutual: false },
    ],
})

describe("graph projection store", () => {
    it("a put projection reads back unchanged under graph:<did>", async () => {
        const did = "did:plc:put-reads-back"
        const store = kvGraphProjections(env)
        expect(await store.get(did)).toBeNull()
        await store.put(projection(did))
        expect(await store.get(did)).toEqual(projection(did))
        expect(await env.records.get(`graph:${did}`, "arrayBuffer")).not.toBeNull()
    })

    it("a put replaces the earlier projection for the same DID only", async () => {
        const store = kvGraphProjections(env)
        const [a, b] = ["did:plc:replace-a", "did:plc:replace-b"]
        await store.put(projection(a))
        await store.put(projection(b))
        const next = { ...projection(a), following: [], followers: [] }
        await store.put(next)
        expect(await store.get(a)).toEqual(next)
        expect(await store.get(b)).toEqual(projection(b))
    })

    it("delete removes it, and get then returns null", async () => {
        const did = "did:plc:delete-removes"
        const other = "did:plc:delete-keeps"
        const store = kvGraphProjections(env)
        await store.put(projection(did))
        await store.put(projection(other))
        await store.delete(did)
        expect(await store.get(did)).toBeNull()
        expect(await env.records.get(`graph:${did}`)).toBeNull()
        expect(await store.get(other)).toEqual(projection(other))
    })

    it("listDids pages every held projection's DID, and only graph: keys", async () => {
        const store = kvGraphProjections(env)
        const dids = ["did:plc:list-a", "did:plc:list-b", "did:plc:list-c"]
        for (const did of dids) await store.put(projection(did))
        await env.records.put("rec:did:plc:list-other", "x")
        await env.records.put("graphite:did:plc:list-other", "x")

        const seen: string[] = []
        let cursor: string | null = null
        let pages = 0
        do {
            const page: { dids: string[]; cursor: string | null } = await store.listDids(cursor, 2)
            seen.push(...page.dids)
            cursor = page.cursor
            pages += 1
        } while (cursor !== null)
        expect(seen.filter((d) => d.startsWith("did:plc:list-"))).toEqual(dids)
        expect(seen.every((d) => d.startsWith("did:"))).toBe(true)
        expect(pages).toBeGreaterThanOrEqual(2)
    })
})
