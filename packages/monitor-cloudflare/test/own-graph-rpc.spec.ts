/** The ingest object's RPC the owner's summary reads the owner's graph through. */
import { beforeEach, describe, expect, it } from "vitest"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import { clearGraph, db, inObj, registeredStub } from "./listing-harness"

beforeEach(clearGraph)

const put = (follower: string, rkey: string, subject: string) =>
    d1FollowEdgeWriter(db, statementBudget(100)).putEdges([{ follower, rkey, subject }], 1)
const seed = async (did: string, table: "graph_owners" | "graph_holders") => {
    await db.prepare(`INSERT OR IGNORE INTO ${table} (did) VALUES (?)`).bind(did).run()
}

describe("MonitorIngest.ownGraph", () => {
    it("returns a served owner's following and followers from D1, each edge flagged mutual iff the reverse edge exists", async () => {
        await seed("did:o", "graph_owners")
        for (const d of ["did:a", "did:b", "did:c"]) await seed(d, "graph_holders")
        await put("did:o", "1", "did:b")
        await put("did:o", "2", "did:a")
        await put("did:a", "3", "did:o")
        await put("did:c", "4", "did:o")
        expect(await inObj(registeredStub("graph"), (obj) => obj.ownGraph("did:o"))).toEqual({
            did: "did:o",
            following: [
                { did: "did:a", mutual: true },
                { did: "did:b", mutual: false },
            ],
            followers: [
                { did: "did:a", mutual: true },
                { did: "did:c", mutual: false },
            ],
        })
    })

    it("answers over the Durable Object RPC boundary", async () => {
        await seed("did:o", "graph_owners")
        await seed("did:a", "graph_holders")
        await put("did:o", "1", "did:a")
        expect(await registeredStub("graph").ownGraph("did:o")).toEqual({
            did: "did:o",
            following: [{ did: "did:a", mutual: false }],
            followers: [],
        })
    })

    it("includes only edges whose other party holds a declaration", async () => {
        await seed("did:o", "graph_owners")
        await seed("did:a", "graph_holders")
        await put("did:o", "1", "did:a")
        await put("did:o", "2", "did:nodecl")
        await put("did:nodecl", "3", "did:o")
        expect(await inObj(registeredStub("graph"), (obj) => obj.ownGraph("did:o"))).toEqual({
            did: "did:o",
            following: [{ did: "did:a", mutual: false }],
            followers: [],
        })
    })

    it("returns null for a DID whose graph is not served", async () => {
        await seed("did:a", "graph_holders")
        await put("did:o", "1", "did:a")
        expect(await inObj(registeredStub("graph"), (obj) => obj.ownGraph("did:o"))).toBeNull()
    })

    it("returns empty edge lists for a served owner who follows and is followed by nobody", async () => {
        await seed("did:o", "graph_owners")
        expect(await inObj(registeredStub("graph"), (obj) => obj.ownGraph("did:o"))).toEqual({
            did: "did:o",
            following: [],
            followers: [],
        })
    })

    it("dedupes two follow records of one pair into one edge", async () => {
        await seed("did:o", "graph_owners")
        await seed("did:a", "graph_holders")
        await put("did:o", "1", "did:a")
        await put("did:o", "2", "did:a")
        await put("did:a", "3", "did:o")
        expect(await inObj(registeredStub("graph"), (obj) => obj.ownGraph("did:o"))).toEqual({
            did: "did:o",
            following: [{ did: "did:a", mutual: true }],
            followers: [{ did: "did:a", mutual: true }],
        })
    })

    it("reads the served bit and both edge lists in one D1 batch", async () => {
        await seed("did:o", "graph_owners")
        await seed("did:a", "graph_holders")
        await put("did:o", "1", "did:a")
        const calls = { batch: 0, other: 0 }
        const countStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
                get(target, prop) {
                    const value = Reflect.get(target, prop, target)
                    if (typeof value !== "function") return value
                    return (...args: unknown[]) => {
                        const out = value.apply(target, args)
                        if (prop === "bind") return countStatement(out)
                        calls.other += 1
                        return out
                    }
                },
            })
        const graph = await inObj(registeredStub("graph"), async (obj) => {
            const real = obj.env.graph!
            const counting = new Proxy(real, {
                get(target, prop) {
                    const value = Reflect.get(target, prop, target)
                    if (typeof value !== "function") return value
                    return (...args: unknown[]) => {
                        if (prop === "prepare") return countStatement(value.apply(target, args))
                        if (prop === "batch") calls.batch += 1
                        else calls.other += 1
                        return value.apply(target, args)
                    }
                },
            })
            ;(obj as unknown as { env: unknown }).env = { ...obj.env, graph: counting }
            return obj.ownGraph("did:o")
        })
        expect(graph?.following).toHaveLength(1)
        expect(calls).toEqual({ batch: 1, other: 0 })
    })

    it("rejects when D1 cannot answer, rather than answering empty", async () => {
        await expect(
            inObj(registeredStub("graph"), async (obj) => {
                const real = obj.env.graph!
                const down = new Proxy(real, {
                    get(target, prop) {
                        if (prop === "batch") return () => Promise.reject(new Error("D1 down"))
                        const value = Reflect.get(target, prop, target)
                        return typeof value === "function" ? value.bind(target) : value
                    },
                })
                ;(obj as unknown as { env: unknown }).env = { ...obj.env, graph: down }
                return obj.ownGraph("did:o")
            })
        ).rejects.toThrow(/D1 down/)
    })
})
