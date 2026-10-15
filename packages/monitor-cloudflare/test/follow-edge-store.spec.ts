/**
 * The follow-edge index in D1: the single writer's edge and membership
 * writes, and the owner's edge read.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
    D1_ROWS_PER_STATEMENT,
    type GraphMirrorRow,
    type GraphMirrorTransition,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeStore, d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import { d1InterestReader } from "../src/interest-reader"
import { MonitorIngest } from "../src/ingest-object"
import { runInDurableObject } from "cloudflare:test"

const testEnv = env as unknown as MonitorEnv & { graph: D1Database }
const db = testEnv.graph

const none: GraphMirrorRow = {
    did: "",
    owner: false,
    holder: false,
    member: false,
    registered: false,
}
const row = (did: string, flags: Partial<GraphMirrorRow> = {}): GraphMirrorRow => ({
    ...none,
    did,
    ...flags,
})
const to = (now: GraphMirrorRow, mirrored: GraphMirrorRow | null = null): GraphMirrorTransition => ({
    now,
    mirrored,
})

const writer = (limit = 1000) => d1FollowEdgeWriter(db, statementBudget(limit))
const mirror = (...transitions: GraphMirrorTransition[]) => writer().mirror(transitions)

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return (await db.prepare(sql).bind(...binds).all<T>()).results
}
const edgeCount = async (follower: string) =>
    (await all<{ n: number }>("SELECT COUNT(*) AS n FROM follows WHERE follower = ?", follower))[0]!.n

/** Make `did` served, a holder, or both. */
async function seed(did: string, flags: { owner?: boolean; holder?: boolean }) {
    if (flags.owner) await db.prepare("INSERT INTO graph_owners (did) VALUES (?)").bind(did).run()
    if (flags.holder) await db.prepare("INSERT INTO graph_holders (did) VALUES (?)").bind(did).run()
}
const seedInterest = (did: string) =>
    db.prepare("INSERT OR IGNORE INTO interest (did, registered) VALUES (?, 0)").bind(did).run()
const edge = (follower: string, rkey: string, subject: string) => ({ follower, rkey, subject })

beforeEach(async () => {
    await db.batch(
        ["follows", "graph_owners", "graph_holders", "interest"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("follow-edge index writer and reads", () => {
    it("ownEdges serves only a served graph, filtered to holders", async () => {
        await seed("did:a", { owner: true, holder: true })
        await seed("did:b", { holder: true })
        await seed("did:c", { owner: true })
        await writer().putEdges(
            [
                edge("did:a", "1", "did:b"),
                edge("did:a", "2", "did:c"),
                edge("did:b", "3", "did:a"),
                edge("did:c", "4", "did:a"),
                edge("did:b", "5", "did:x"),
            ],
            1
        )
        const store = d1FollowEdgeStore(db)
        // a is served: its subjects keep only the holder b, and so do its followers.
        expect(await store.ownEdges("did:a")).toEqual({
            following: [edge("did:a", "1", "did:b")],
            followers: [edge("did:b", "3", "did:a")],
        })
        // b is a holder but not served.
        expect(await store.ownEdges("did:b")).toBeNull()
        // c is served and answers both ways, filtered to holders.
        expect(await store.ownEdges("did:c")).toEqual({
            following: [edge("did:c", "4", "did:a")],
            followers: [edge("did:a", "2", "did:c")],
        })
    })

    it("sweep removes rows older than the listing generation", async () => {
        const w = writer()
        await w.putEdges([edge("did:a", "old", "did:s1")], 1)
        await w.putEdges([edge("did:a", "new", "did:s2"), edge("did:b", "other", "did:s3")], 2)
        const result = await writer().sweep("did:a", 2)
        expect(result.subjects).toEqual(["did:s1"])
        expect(await all("SELECT rkey FROM follows ORDER BY rkey")).toEqual([
            { rkey: "new" },
            { rkey: "other" },
        ])
    })

    it("sweep and prune report the subjects of the edges they remove", async () => {
        await writer().putEdges([edge("did:a", "1", "did:s1")], 1)
        await writer().putEdges([edge("did:a", "2", "did:s2")], 2)
        expect((await writer().sweep("did:a", 2)).subjects).toEqual(["did:s1"])
        // Nothing older is left.
        expect((await writer().sweep("did:a", 2)).subjects).toEqual([])
        expect((await writer().pruneFollower("did:a")).subjects).toEqual(["did:s2"])
        expect(await edgeCount("did:a")).toBe(0)
    })

    it("a put that re-points a follow notes the old subject", async () => {
        await seed("did:old", { holder: true })
        await writer().putEdges([edge("did:a", "1", "did:old")], 1)
        const result = await writer().putEdges([edge("did:a", "1", "did:new")], 1)
        expect(result.subjects.sort()).toEqual(["did:new", "did:old"])
    })

    it("deleting more than 25 refs reports every subject", async () => {
        const ids = Array.from({ length: 30 }, (_, i) => i)
        await Promise.all(ids.map((i) => seed(`did:h${i}`, { holder: true })))
        await writer().putEdges(
            ids.map((i) => edge("did:a", `${i}`, `did:h${i}`)),
            1
        )
        const result = await writer().deleteEdges(ids.map((i) => ({ follower: "did:a", rkey: `${i}` })))
        expect(result.subjects).toHaveLength(30)
        expect(await edgeCount("did:a")).toBe(0)
    })

    it("prune removes every edge of a follower", async () => {
        const w = writer()
        await w.putEdges(
            [edge("did:a", "1", "did:s1"), edge("did:a", "2", "did:s2"), edge("did:b", "3", "did:s1")],
            1
        )
        const result = await writer().pruneFollower("did:a")
        expect(result.subjects.sort()).toEqual(["did:s1", "did:s2"])
        expect(await edgeCount("did:a")).toBe(0)
        expect(await edgeCount("did:b")).toBe(1)
    })

    it("put is idempotent on (follower, rkey)", async () => {
        await writer().putEdges([edge("did:a", "1", "did:s1")], 1)
        await writer().putEdges([edge("did:a", "1", "did:s2")], 2)
        await writer().putEdges([edge("did:a", "1", "did:s2")], 2)
        expect(await all("SELECT follower, rkey, subject, gen FROM follows")).toEqual([
            { follower: "did:a", rkey: "1", subject: "did:s2", gen: 2 },
        ])
        const deleted = await writer().deleteEdges([
            { follower: "did:a", rkey: "1" },
            { follower: "did:a", rkey: "absent" },
        ])
        expect(deleted.subjects).toEqual(["did:s2"])
        expect(await edgeCount("did:a")).toBe(0)
    })

    it("each write is sent as one batch", async () => {
        const calls: number[] = []
        const counting = {
            prepare: (sql: string) => db.prepare(sql),
            batch: async (statements: D1PreparedStatement[]) => {
                calls.push(statements.length)
                return db.batch(statements)
            },
        } as unknown as D1Database
        await d1FollowEdgeWriter(counting, statementBudget(100)).putEdges(
            [edge("did:a", "1", "did:s1")],
            1
        )
        await d1FollowEdgeWriter(counting, statementBudget(100)).deleteEdges([
            { follower: "did:a", rkey: "1" },
        ])
        await d1FollowEdgeWriter(counting, statementBudget(100)).mirror([
            to(row("did:m", { holder: true, member: true })),
        ])
        // The old-subject read and the upsert; the delete; the five mirror statements.
        expect(calls).toEqual([2, 1, 5])
    })

    it("a holder that stops being one keeps its edges, and an owner removal prunes them", async () => {
        await mirror(to(row("did:holder", { holder: true, member: true })))
        await mirror(to(row("did:x", { holder: true, member: true })))
        await mirror(to(row("did:f1", { owner: true, member: true })))
        await writer().putEdges(
            [edge("did:f1", "1", "did:x"), edge("did:x", "2", "did:holder")],
            1
        )

        await mirror(
            to(row("did:x", { holder: false, member: true }), row("did:x", { holder: true, member: true }))
        )
        expect(await all("SELECT did FROM graph_holders ORDER BY did")).toEqual([{ did: "did:holder" }])
        // A holder that merely stops being a holder keeps its edges.
        expect(await edgeCount("did:x")).toBe(1)

        await mirror(
            to(row("did:f1", { owner: false, member: true }), row("did:f1", { owner: true, member: true }))
        )
        expect(await edgeCount("did:f1")).toBe(0)
    })

    it("graph_owners tracks the served flag", async () => {
        await mirror(to(row("did:o", { owner: true, member: true })))
        expect(await all("SELECT did FROM graph_owners")).toEqual([{ did: "did:o" }])
        await mirror(to(row("did:o", { member: true }), row("did:o", { owner: true, member: true })))
        expect(await all("SELECT did FROM graph_owners")).toEqual([])
    })

    it("a prune, sweep or fan-out is a constant number of statements", async () => {
        const spend = async (n: number) => {
            const fill = async () => {
                await db.exec("DELETE FROM follows")
                await writer().putEdges(
                    Array.from({ length: n }, (_, i) => edge("did:a", `${i}`, `did:s${i}`)),
                    1
                )
            }
            const cost = async (run: (w: ReturnType<typeof d1FollowEdgeWriter>) => Promise<unknown>) => {
                await fill()
                const budget = statementBudget(1000)
                await run(d1FollowEdgeWriter(db, budget))
                return 1000 - budget.remaining
            }
            return [
                await cost((w) => w.pruneFollower("did:a")),
                await cost((w) => w.sweep("did:a", 2)),
                await cost(async (w) => {
                    await seedInterest("did:a")
                    await w.mirror([to(row("did:a"), row("did:a", { member: true }))])
                    expect(await edgeCount("did:a")).toBe(0)
                }),
            ]
        }
        const small = await spend(2)
        expect(await spend(200)).toEqual(small)
        expect(small.every((c) => c > 0 && c < 15)).toBe(true)
    })

    it("a removed owner's edges, and a leaving member's, are pruned and their subjects reported", async () => {
        await mirror(to(row("did:h", { holder: true, member: true })))
        await mirror(to(row("did:f1", { owner: true, member: true })))
        await writer().putEdges([edge("did:f1", "1", "did:h")], 1)
        const removed = await mirror(
            to(row("did:f1", { member: true }), row("did:f1", { owner: true, member: true }))
        )
        expect(await edgeCount("did:f1")).toBe(0)
        expect(removed.subjects).toEqual(["did:h"])

        await mirror(to(row("did:m", { member: true })))
        await writer().putEdges([edge("did:m", "2", "did:h")], 1)
        const left = await mirror(to(row("did:m"), row("did:m", { member: true })))
        expect(await edgeCount("did:m")).toBe(0)
        expect(left.subjects).toEqual(["did:h"])
    })

    it("re-mirroring an unchanged DID leaves its rows as they were", async () => {
        const standing = row("did:h", { holder: true, owner: true, member: true, registered: true })
        await mirror(to(standing))
        await mirror(to(standing, standing))
        await mirror(to(standing, null))
        expect(await all("SELECT did FROM graph_owners")).toEqual([{ did: "did:h" }])
        expect(await all("SELECT did FROM graph_holders")).toEqual([{ did: "did:h" }])
        expect(await all("SELECT did, registered FROM interest")).toEqual([
            { did: "did:h", registered: 1 },
        ])
    })

    it("inserts chunk at 25 rows per statement", async () => {
        const inserts: string[] = []
        const recording = {
            prepare: (sql: string) => {
                if (sql.startsWith("INSERT INTO follows")) inserts.push(sql)
                return db.prepare(sql)
            },
            batch: (statements: D1PreparedStatement[]) => db.batch(statements),
        } as unknown as D1Database
        const edges = Array.from({ length: 60 }, (_, i) => edge("did:a", `${i}`, `did:s${i}`))
        await d1FollowEdgeWriter(recording, statementBudget(1000)).putEdges(edges, 1)
        expect(D1_ROWS_PER_STATEMENT).toBe(25)
        const tuples = inserts.map((sql) => (sql.match(/\(\?/g) ?? []).length)
        expect(tuples).toEqual([25, 25, 10])
        expect(await edgeCount("did:a")).toBe(60)
    })

    it("a write the statement budget cannot cover sends nothing", async () => {
        await expect(
            d1FollowEdgeWriter(db, statementBudget(1)).putEdges(
                [edge("did:a", "1", "did:s1"), edge("did:a", "2", "did:s2")],
                1
            )
        ).rejects.toThrow(/budget/)
        expect(await edgeCount("did:a")).toBe(0)
        const budget = statementBudget(3)
        expect(budget.take(2)).toBe(true)
        expect(budget.remaining).toBe(1)
        expect(budget.take(1)).toBe(true)
        expect(budget.remaining).toBe(0)
        expect(budget.take(2)).toBe(false)
    })

    it("the object fails at startup without the graph binding", async () => {
        const stub = testEnv.ingest.get(testEnv.ingest.idFromName("graph-binding"))
        await runInDurableObject(stub, async (_obj, state) => {
            let startup: Promise<unknown> | undefined
            Object.assign(state, {
                blockConcurrencyWhile(fn: () => Promise<unknown>) {
                    startup = fn()
                    return startup
                },
            })
            new MonitorIngest(state, { ...testEnv, graph: undefined })
            await expect(startup).rejects.toThrow(/graph/)
        })
    })
})

describe("interest reader", () => {
    it("InterestReader serves, isRegistered and servedGraphs read the mirrored tables", async () => {
        await mirror(
            to(row("did:a", { owner: true, member: true, registered: true })),
            to(row("did:b", { member: true })),
            to(row("did:c", { owner: true, member: true }))
        )
        const reader = d1InterestReader(db)
        expect(await reader.serves("did:a")).toBe(true)
        expect(await reader.serves("did:b")).toBe(true)
        expect(await reader.serves("did:nobody")).toBe(false)
        expect(await reader.isRegistered("did:a")).toBe(true)
        expect(await reader.isRegistered("did:b")).toBe(false)
        expect(await reader.isRegistered("did:nobody")).toBe(false)
        expect(await reader.servedGraphs(null, 1)).toEqual({ dids: ["did:a"], cursor: "did:a" })
        expect(await reader.servedGraphs("did:a", 1)).toEqual({ dids: ["did:c"], cursor: null })
    })
})
