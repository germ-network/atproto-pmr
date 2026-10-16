/** Live blocks from the follow/profile socket through to D1. */
import { env, runInDurableObject } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decodeEvent, flushEdgeOps, flushLimit, routeFollowEvent } from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import { monitorCollections, type MonitorEnv } from "../src/env"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv & {
    graph: D1Database
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
const db = testEnv.graph
const FOLLOW = "app.bsky.graph.follow"
const BLOCK = "app.bsky.graph.block"

let n = 0
const registeredStub = () => {
    n += 1
    return testEnv.ingestRegistered.get(testEnv.ingestRegistered.idFromName(`block-socket-${n}`))
}
const inObj = <R>(stub: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(stub, (obj) => fn(obj as MonitorIngest))
const sql = (obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    (obj as unknown as { db: DurableObjectStorage }).db.sql.exec(query, ...binds)
const rowsOf = <T>(obj: MonitorIngest, query: string, ...binds: unknown[]) => sql(obj, query, ...binds).toArray() as T[]
async function all<T>(query: string): Promise<T[]> {
    return (await db.prepare(query).all<T>()).results
}
const blocks = () =>
    all<{ blocker: string; rkey: string; subject: string }>(
        "SELECT blocker, rkey, subject FROM blocks ORDER BY blocker, rkey"
    )
const follows = () =>
    all<{ follower: string; rkey: string; subject: string }>(
        "SELECT follower, rkey, subject FROM follows ORDER BY follower, rkey"
    )

const commit = (did: string, collection: string, operation: string, rkey: string, subject?: string) =>
    JSON.stringify({
        did,
        time_us: 1000,
        kind: "commit",
        commit: {
            rev: "3rev",
            operation,
            collection,
            rkey,
            cid: "bafy",
            ...(subject ? { record: { subject } } : {}),
        },
    })
const route = (obj: MonitorIngest, raw: string) => {
    const event = decodeEvent(raw)
    if (event === null) throw new Error("undecodable test frame")
    return routeFollowEvent({ index: obj, secondaries: monitorCollections(obj.env) }, event, "1000")
}
const flush = (obj: MonitorIngest, limit = 1000, budget = statementBudget(1000)) =>
    flushEdgeOps(
        {
            ops: obj,
            edges: d1FollowEdgeWriter(db, budget),
            blocks: d1BlockEdgeWriter(db, budget),
            budget,
            interest: obj,
        },
        limit
    )

const original = globalThis.fetch
afterEach(() => {
    globalThis.fetch = original
    vi.restoreAllMocks()
})
beforeEach(async () => {
    await db.batch(
        ["blocks", "follows", "graph_owners", "graph_holders", "interest"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("follow socket — blocks", () => {
    it("subscribes the follow socket to the block collection", async () => {
        const urls: URL[] = []
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            urls.push(new URL(input instanceof Request ? input.url : String(input)))
            const [client, server] = Object.values(new WebSocketPair())
            server!.accept()
            return new Response(null, { status: 101, webSocket: client })
        }) as typeof fetch
        await inObj(registeredStub(), (obj) => obj.connectFollow())
        expect(urls[0]!.searchParams.getAll("collections")).toContain(BLOCK)
    })

    it("flushes a kept block create and delete to the D1 blocks table", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:owner", true, 1)
            expect(await route(obj, commit("did:owner", BLOCK, "create", "b1", "did:x"))).toBe("edge-op")
            expect(await route(obj, commit("did:owner", BLOCK, "create", "b2", "did:y"))).toBe("edge-op")
            expect(await flush(obj)).toBe(2)
            expect(await blocks()).toEqual([
                { blocker: "did:owner", rkey: "b1", subject: "did:x" },
                { blocker: "did:owner", rkey: "b2", subject: "did:y" },
            ])
            expect(await route(obj, commit("did:owner", BLOCK, "delete", "b1"))).toBe("edge-op")
            await flush(obj)
            expect((await blocks()).map((b) => b.rkey)).toEqual(["b2"])
        })
        expect(await follows()).toEqual([])
    })

    it("queues no owner_followers re-count for a block write", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:owner", true, 1)
            await route(obj, commit("did:owner", BLOCK, "create", "b1", "did:x"))
            await route(obj, commit("did:owner", BLOCK, "delete", "b1"))
            await route(obj, commit("did:owner", BLOCK, "create", "b2", "did:y"))
            await flush(obj)
            expect(rowsOf(obj, "SELECT did FROM recount_queue")).toEqual([])
            await route(obj, commit("did:owner", FOLLOW, "create", "f1", "did:z"))
            await flush(obj)
            expect(rowsOf(obj, "SELECT did FROM recount_queue").length).toBeGreaterThan(0)
        })
    })

    it("logs follow and block ops in one ordered edge_ops log", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:owner", true, 1)
            await route(obj, commit("did:owner", FOLLOW, "create", "r1", "did:f"))
            await route(obj, commit("did:owner", BLOCK, "create", "r2", "did:b"))
            await route(obj, commit("did:owner", BLOCK, "delete", "r2"))
            await route(obj, commit("did:owner", FOLLOW, "delete", "r1"))
            const ops = await obj.edgeOps(10)
            expect(ops.map((o) => [o.collection, o.kind, o.rkey])).toEqual([
                ["follow", "create", "r1"],
                ["block", "create", "r2"],
                ["block", "delete", "r2"],
                ["follow", "delete", "r1"],
            ])
            expect(ops.map((o) => o.seq)).toEqual([...ops.map((o) => o.seq)].sort((a, b) => a - b))
        })
    })

    it("a follow op and a block op sharing an rkey neither coalesce nor cancel", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:owner", true, 1)
            await route(obj, commit("did:owner", FOLLOW, "create", "same", "did:f"))
            await route(obj, commit("did:owner", BLOCK, "create", "same", "did:b"))
            await flush(obj)
            expect(await follows()).toEqual([{ follower: "did:owner", rkey: "same", subject: "did:f" }])
            expect(await blocks()).toEqual([{ blocker: "did:owner", rkey: "same", subject: "did:b" }])
            await route(obj, commit("did:owner", BLOCK, "delete", "same"))
            await flush(obj)
            expect(await blocks()).toEqual([])
            expect(await follows()).toHaveLength(1)
        })
    })

    it("a flush of mixed follow and block ops stays within the statement budget", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:owner", true, 1)
            // The first 25 ops are 22 follow creates, a follow delete, a block
            // create and a block delete: five statements' worth.
            for (let i = 0; i < 22; i++) {
                await route(obj, commit("did:owner", FOLLOW, "create", `f${i}`, `did:s${i}`))
            }
            await route(obj, commit("did:owner", FOLLOW, "delete", "f0"))
            await route(obj, commit("did:owner", BLOCK, "create", "b0", "did:x"))
            await route(obj, commit("did:owner", BLOCK, "delete", "b1"))
            for (let i = 0; i < 40; i++) {
                await route(obj, commit("did:owner", FOLLOW, "create", `g${i}`, `did:t${i}`))
            }
            const budget = statementBudget(5)
            expect(flushLimit(budget.remaining)).toBe(25)
            expect(await flush(obj, flushLimit(budget.remaining), budget)).toBe(25)
            expect(budget.remaining).toBeGreaterThanOrEqual(0)
            expect(rowsOf<{ n: number }>(obj, "SELECT COUNT(*) AS n FROM edge_ops")[0]!.n).toBe(40)
        })
    })
})
