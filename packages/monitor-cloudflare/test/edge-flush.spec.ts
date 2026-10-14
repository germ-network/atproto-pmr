/**
 * Draining the live follow log into D1, and keeping each followee's count of
 * owner followers, and so its place in interest, in step with every edge
 * write.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
    drainRecounts,
    flushEdgeOps,
    flushLimit,
    mirrorGraph,
    reconcileGraphMirror,
    reconcileOwnerFollowers,
    type StatementBudget,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv & {
    graph: D1Database
    pmrDirectory: KVNamespace
    ingest: DurableObjectNamespace<MonitorIngest>
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
const db = testEnv.graph

let n = 0
const stubIn = (ns: DurableObjectNamespace<MonitorIngest>) => {
    n += 1
    return ns.get(ns.idFromName(`edge-flush-${n}`))
}
const registeredStub = () => stubIn(testEnv.ingestRegistered)
const everyoneStub = () => stubIn(testEnv.ingest)
const inObj = <R>(s: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(s, (obj) => fn(obj as MonitorIngest))

const sql = (obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    (obj as unknown as { db: DurableObjectStorage }).db.sql.exec(query, ...binds)
const rowsOf = <T>(obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    sql(obj, query, ...binds).toArray() as T[]

async function all<T>(query: string, ...binds: unknown[]): Promise<T[]> {
    return (await db.prepare(query).bind(...binds).all<T>()).results
}
const follows = () =>
    all<{ follower: string; rkey: string; subject: string; gen: number }>(
        "SELECT follower, rkey, subject, gen FROM follows ORDER BY follower, rkey"
    )
const putEdge = (follower: string, rkey: string, subject: string) =>
    db
        .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, 1)")
        .bind(follower, rkey, subject)
        .run()

const create = (obj: MonitorIngest, follower: string, rkey: string, subject: string) =>
    obj.logEdgeOp({ kind: "create", follower, rkey, subject, rev: "r", cursor: "1" }, "1")
const del = (obj: MonitorIngest, follower: string, rkey: string) =>
    obj.logEdgeOp({ kind: "delete", follower, rkey, rev: "r", cursor: "1" }, "1")

const opCount = (obj: MonitorIngest) => rowsOf<{ n: number }>(obj, "SELECT COUNT(*) AS n FROM edge_ops")[0]!.n
const queued = (obj: MonitorIngest) =>
    rowsOf<{ did: string }>(obj, "SELECT did FROM recount_queue ORDER BY did").map((r) => r.did)
const ownerFollowers = (obj: MonitorIngest, did: string) =>
    rowsOf<{ owner_followers: number }>(obj, "SELECT owner_followers FROM interest WHERE did = ?", did)[0]
        ?.owner_followers
const interestRows = (obj: MonitorIngest) =>
    rowsOf<{ did: string }>(obj, "SELECT did FROM interest ORDER BY did").map((r) => r.did)

/** Make `did` a member with `owner_followers` already counted, as an earlier re-count left it. */
const seedFollowee = (obj: MonitorIngest, did: string, count: number) =>
    sql(
        obj,
        "INSERT OR REPLACE INTO interest (did, member, owner_followers, epoch) VALUES (?, 1, ?, 1)",
        did,
        count
    )

const flushDeps = (obj: MonitorIngest, budget: StatementBudget) => ({
    ops: obj,
    edges: d1FollowEdgeWriter(db, budget),
    budget,
    interest: obj,
})
const flush = (obj: MonitorIngest, limit = 1000, budget = statementBudget(1000)) =>
    flushEdgeOps(flushDeps(obj, budget), limit)
const ownerDeps = (obj: MonitorIngest, budget: StatementBudget) => ({
    edges: d1FollowEdgeWriter(db, budget),
    interest: obj,
    nowMs: () => Date.now(),
})
const drain = (obj: MonitorIngest, budget = statementBudget(1000), limit = 1000) =>
    drainRecounts({ ...ownerDeps(obj, budget), queue: obj, budget }, limit)

async function alarm(s: DurableObjectStub<MonitorIngest>) {
    await inObj(s, (obj) => (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog())
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
    try {
        await runDurableObjectAlarm(s)
    } catch (err) {
        if (!/did not upgrade/.test(String(err))) throw err
    } finally {
        globalThis.fetch = original
    }
}

beforeEach(async () => {
    await db.batch(
        ["follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("edge_ops flush", () => {
    it("create flushes as an edge at the current generation", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            sql(obj, "INSERT INTO meta (k, v) VALUES ('listing_gen', '3')")
            await create(obj, "did:f", "r1", "did:s")
            expect(await flush(obj)).toBe(1)
            expect(opCount(obj)).toBe(0)
        })
        expect(await follows()).toEqual([{ follower: "did:f", rkey: "r1", subject: "did:s", gen: 3 }])
    })

    it("delete flushes by (follower, rkey) and returns its subject", async () => {
        const s = registeredStub()
        await putEdge("did:f", "r1", "did:s")
        await putEdge("did:f", "r2", "did:other")
        await inObj(s, async (obj) => {
            await del(obj, "did:f", "r1")
            await flush(obj)
            expect(queued(obj)).toEqual(["did:s"])
        })
        expect((await follows()).map((r) => r.rkey)).toEqual(["r2"])
    })

    it("delete of an absent edge is a no-op", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await del(obj, "did:f", "nope")
            expect(await flush(obj)).toBe(1)
            expect(opCount(obj)).toBe(0)
            expect(queued(obj)).toEqual([])
        })
        expect(await follows()).toEqual([])
    })

    it("unflushed ops survive a failed batch", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            await create(obj, "did:f", "r1", "did:s")
            await del(obj, "did:g", "r2")
            // A budget that cannot cover the write sends nothing.
            await expect(flush(obj, 1000, statementBudget(0))).rejects.toThrow(/budget/)
            expect(opCount(obj)).toBe(2)
            expect(queued(obj)).toEqual([])
            expect(await flush(obj)).toBe(2)
            expect(opCount(obj)).toBe(0)
        })
        expect(await follows()).toHaveLength(1)
    })

    it("a create and delete of one follow in one flush leave the last op's state", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            await create(obj, "did:f", "r1", "did:s")
            await del(obj, "did:f", "r1")
            await create(obj, "did:f", "r2", "did:t")
            await del(obj, "did:f", "r2")
            await create(obj, "did:f", "r2", "did:u")
            await flush(obj)
        })
        expect(await follows()).toEqual([{ follower: "did:f", rkey: "r2", subject: "did:u", gen: 0 }])
    })

    it("an op logged during the flush's D1 await survives the drop", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            await create(obj, "did:f", "r1", "did:s")
            const budget = statementBudget(1000)
            const deps = flushDeps(obj, budget)
            const put = deps.edges.putEdges.bind(deps.edges)
            deps.edges.putEdges = async (edges, gen) => {
                await create(obj, "did:f", "r2", "did:t")
                return put(edges, gen)
            }
            await flushEdgeOps(deps, 1000)
            expect(rowsOf<{ rkey: string }>(obj, "SELECT rkey FROM edge_ops")).toEqual([{ rkey: "r2" }])
        })
        expect((await follows()).map((r) => r.rkey)).toEqual(["r1"])
    })

    it("a logged create by a follower that has since left interest is not written", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await create(obj, "did:left", "r1", "did:s")
            await obj.setRegistered("did:in", true, 1)
            await create(obj, "did:in", "r1", "did:s")
            await flush(obj)
            expect(opCount(obj)).toBe(0)
        })
        expect((await follows()).map((r) => r.follower)).toEqual(["did:in"])
    })

    it("the flush runs after the mirror", async () => {
        const s = registeredStub()
        const order = await inObj(s, async (obj) => {
            const seen: string[] = []
            const wrap = <K extends "dueMirror" | "edgeOps" | "dueRecounts">(name: K) => {
                const original = obj[name].bind(obj) as (...a: unknown[]) => Promise<unknown>
                ;(obj as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
                    seen.push(name)
                    return original(...a)
                }
            }
            wrap("dueMirror")
            wrap("edgeOps")
            wrap("dueRecounts")
            return seen
        })
        await alarm(s)
        expect(order.slice(0, 3)).toEqual(["dueMirror", "edgeOps", "dueRecounts"])
    })

    it("the flush is sized by its worst-case statements within the shared budget", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            for (let i = 0; i < 200; i++) await create(obj, "did:f", `r${i}`, "did:s")
            const budget = statementBudget(30)
            const done = await flush(obj, flushLimit(budget.remaining), budget)
            expect(done).toBe(125)
            expect(budget.remaining).toBeGreaterThanOrEqual(0)
            expect(opCount(obj)).toBe(75)
        })
        expect(await follows()).toHaveLength(125)
    })

    it("a backlog larger than one alarm's budget drains over several alarms", async () => {
        const s = registeredStub()
        // The daily registration reconcile keeps only DIDs the relay lists.
        await testEnv.pmrDirectory.put("did:f", "1")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:f", true, 1)
            for (let i = 0; i < 3800; i++) await create(obj, "did:f", `r${i}`, `did:s${i % 50}`)
        })
        const left: number[] = []
        for (let i = 0; i < 4; i++) {
            await alarm(s)
            left.push(await inObj(s, async (obj) => opCount(obj)))
            if (left.at(-1) === 0) break
        }
        expect(left[0]).toBeGreaterThan(0)
        expect(left.at(-1)).toBe(0)
        expect(left.length).toBeGreaterThan(1)
        expect(await follows()).toHaveLength(3800)
    })
})

describe("owner_followers", () => {
    it("an owner's new followee joins interest after the flush commits", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            await create(obj, "did:o", "r1", "did:s")
            await flush(obj)
            expect(await obj.inInterest("did:s")).toBe(false)
            await drain(obj)
            expect(await obj.inInterest("did:s")).toBe(true)
            expect(ownerFollowers(obj, "did:s")).toBe(1)
            expect(await obj.dueTransitions(10)).toContainEqual(
                expect.objectContaining({ did: "did:s", change: "join" })
            )
        })
    })

    it("a mirror prune re-counts the pruned edges' subjects", async () => {
        const s = registeredStub()
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:f', 0)").run()
        await putEdge("did:f", "1", "did:s1")
        await putEdge("did:f", "2", "did:s2")
        await inObj(s, async (obj) => {
            seedFollowee(obj, "did:s1", 1)
            sql(
                obj,
                "INSERT INTO graph_mirrored (did, owner, holder, member, registered) VALUES ('did:f', 0, 0, 1, 0)"
            )
            const budget = statementBudget(1000)
            await mirrorGraph(
                { index: obj, edges: d1FollowEdgeWriter(db, budget), nowMs: () => Date.now() },
                10
            )
            expect(queued(obj)).toEqual(["did:s1", "did:s2"])
            await drain(obj)
            expect(ownerFollowers(obj, "did:s1")).toBe(0)
            expect(await obj.inInterest("did:s1")).toBe(false)
        })
    })

    it("a reconcile prune re-counts the pruned edges' subjects", async () => {
        const s = registeredStub()
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:f', 0)").run()
        await putEdge("did:f", "1", "did:s1")
        await inObj(s, async (obj) => {
            let cursor = null as Awaited<ReturnType<typeof reconcileGraphMirror>>
            const budget = statementBudget(1000)
            do {
                cursor = await reconcileGraphMirror(
                    { index: obj, edges: d1FollowEdgeWriter(db, budget), nowMs: () => Date.now() },
                    cursor,
                    10
                )
            } while (cursor !== null)
            expect(queued(obj)).toEqual(["did:s1"])
        })
    })

    it("the recount counts graph owners, not the served flag", async () => {
        const s = registeredStub()
        // D1's graph_owners is empty: nothing is served.
        await putEdge("did:o", "1", "did:s")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            await obj.queueRecount(["did:s"], 1)
            await drain(obj)
            expect(ownerFollowers(obj, "did:s")).toBe(1)
        })
    })

    it("the recount counts distinct owner followers", async () => {
        const s = registeredStub()
        await putEdge("did:o1", "1", "did:s")
        await putEdge("did:o1", "2", "did:s")
        await putEdge("did:o2", "1", "did:s")
        await putEdge("did:plain", "1", "did:s")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o1", true, 1)
            await obj.setRegistered("did:o2", true, 1)
            await obj.queueRecount(["did:s"], 1)
            await drain(obj)
            expect(ownerFollowers(obj, "did:s")).toBe(2)
        })
    })

    it("re-applying the same edge batch leaves counts unchanged", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            for (let i = 0; i < 2; i++) {
                await create(obj, "did:o", "r1", "did:s")
                await flush(obj)
                await drain(obj)
                expect(ownerFollowers(obj, "did:s")).toBe(1)
            }
        })
        expect(await follows()).toHaveLength(1)
    })

    it("an unfollowed DID with no owner followers leaves interest", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            await create(obj, "did:o", "r1", "did:s")
            await flush(obj)
            await drain(obj)
            await del(obj, "did:o", "r1")
            await flush(obj)
            await drain(obj)
            expect(ownerFollowers(obj, "did:s")).toBe(0)
            expect(await obj.inInterest("did:s")).toBe(false)
            expect(await obj.dueTransitions(10)).toContainEqual(
                expect.objectContaining({ did: "did:s", change: "leave" })
            )
        })
    })

    it("a pruned owner's followees are re-counted over successive drains when the budget runs out", async () => {
        const s = registeredStub()
        const subjects = Array.from({ length: 120 }, (_, i) => `did:s${String(i).padStart(3, "0")}`)
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:o', 0)").run()
        await db.batch(
            subjects.map((subject, i) =>
                db
                    .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES ('did:o', ?, ?, 1)")
                    .bind(`r${i}`, subject)
            )
        )
        await inObj(s, async (obj) => {
            for (const subject of subjects) seedFollowee(obj, subject, 1)
            sql(
                obj,
                "INSERT INTO graph_mirrored (did, owner, holder, member, registered) VALUES ('did:o', 0, 0, 1, 0)"
            )
            const budget = statementBudget(1000)
            await mirrorGraph(
                { index: obj, edges: d1FollowEdgeWriter(db, budget), nowMs: () => Date.now() },
                10
            )
            expect(queued(obj)).toHaveLength(120)
            // Two statements cover 100 subjects; the rest wait for the next alarm.
            expect(await drain(obj, statementBudget(2))).toBe(100)
            expect(queued(obj)).toHaveLength(20)
            expect(await drain(obj, statementBudget(2))).toBe(20)
            expect(queued(obj)).toEqual([])
            for (const subject of subjects) expect(ownerFollowers(obj, subject)).toBe(0)
        })
    })

    it("a flush whose re-count does not fit is not re-applied forever", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            await create(obj, "did:o", "r1", "did:s")
            expect(await flush(obj)).toBe(1)
            expect(await drain(obj, statementBudget(0))).toBe(0)
            // The write is done: a second flush has nothing to apply, and the
            // owed re-count is still queued.
            expect(await flush(obj)).toBe(0)
            expect(queued(obj)).toEqual(["did:s"])
            expect(await drain(obj)).toBe(1)
            expect(ownerFollowers(obj, "did:s")).toBe(1)
        })
    })

    it("under everyone the recount writes no interest rows", async () => {
        const s = everyoneStub()
        await inObj(s, async (obj) => {
            sql(obj, "INSERT INTO interest (did, member, epoch) VALUES ('did:o', 1, 1)")
            await create(obj, "did:o", "r1", "did:s")
            await flush(obj)
            expect(await drain(obj)).toBe(0)
            const budget = statementBudget(1000)
            await reconcileOwnerFollowers(
                { ...ownerDeps(obj, budget), followed: obj, budget },
                null,
                10
            )
            expect(interestRows(obj)).toEqual(["did:o"])
        })
        expect(await follows()).toHaveLength(1)
    })

    it("under everyone, committed edge writes queue no re-count", async () => {
        const s = everyoneStub()
        await putEdge("did:f", "old", "did:x")
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:g', 0)").run()
        await putEdge("did:g", "1", "did:y")
        await inObj(s, async (obj) => {
            sql(obj, "INSERT INTO interest (did, member, epoch) VALUES ('did:o', 1, 1)")
            await create(obj, "did:o", "r1", "did:s")
            await del(obj, "did:f", "old")
            await flush(obj)
            sql(
                obj,
                "INSERT INTO graph_mirrored (did, owner, holder, member, registered) VALUES ('did:g', 0, 0, 1, 0)"
            )
            const budget = statementBudget(1000)
            await mirrorGraph(
                { index: obj, edges: d1FollowEdgeWriter(db, budget), nowMs: () => Date.now() },
                10
            )
            expect(queued(obj)).toEqual([])
        })
        expect(await follows()).toHaveLength(1)
    })

    it("a zero count for a DID with no interest row writes nothing", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers("did:none", 0, 1)
            expect(interestRows(obj)).toEqual([])
            expect(await obj.dueTransitions(10)).toEqual([])
        })
    })

    it("daily reconcile corrects a drifted owner_followers count", async () => {
        const s = registeredStub()
        await putEdge("did:o", "1", "did:drift")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            seedFollowee(obj, "did:drift", 5)
            // A decrement the queue never saw: the edge is gone from D1.
            seedFollowee(obj, "did:lost", 1)
            const budget = statementBudget(1000)
            const next = await reconcileOwnerFollowers(
                { ...ownerDeps(obj, budget), followed: obj, budget },
                null,
                10
            )
            expect(next).toBeNull()
            expect(ownerFollowers(obj, "did:drift")).toBe(1)
            expect(ownerFollowers(obj, "did:lost")).toBe(0)
            expect(await obj.inInterest("did:lost")).toBe(false)
        })
    })

    it("the owner_followers reconcile resumes from its meta cursor", async () => {
        const s = registeredStub()
        const name = (i: number) => `did:s${String(i).padStart(3, "0")}`
        // The first page keeps a real owner follower, so a pass that re-paged
        // it would not find it already at 0.
        await db.batch(
            Array.from({ length: 200 }, (_, i) =>
                db
                    .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES ('did:o', ?, ?, 1)")
                    .bind(`r${i}`, name(i))
            )
        )
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:o", true, 1)
            for (let i = 0; i < 250; i++) seedFollowee(obj, name(i), 1)
            const budget = statementBudget(1000)
            const step = () =>
                (
                    obj as unknown as {
                        reconcileOwnerFollowerCounts(d: unknown): Promise<void>
                    }
                ).reconcileOwnerFollowerCounts({ ...ownerDeps(obj, budget), followed: obj, budget })
            const meta = (k: string) =>
                rowsOf<{ v: string }>(obj, "SELECT v FROM meta WHERE k = ?", k)[0]?.v
            await step()
            expect(meta("owner_followers_cursor")).toBe("did:s199")
            expect(ownerFollowers(obj, "did:s000")).toBe(1)
            expect(ownerFollowers(obj, "did:s249")).toBe(1)
            await step()
            expect(meta("owner_followers_cursor")).toBeUndefined()
            expect(meta("owner_followers_done")).toBeDefined()
            expect(ownerFollowers(obj, "did:s249")).toBe(0)
            // Done for the day: the next call does nothing.
            seedFollowee(obj, "did:late", 3)
            await step()
            expect(ownerFollowers(obj, "did:late")).toBe(3)
        })
    })

    it("an ex-owner's followees are corrected by the daily reconcile", async () => {
        const s = registeredStub()
        await putEdge("did:ex", "1", "did:s")
        await inObj(s, async (obj) => {
            // Still in interest (someone owner-follows it), no longer registered.
            seedFollowee(obj, "did:ex", 1)
            seedFollowee(obj, "did:s", 1)
            const budget = statementBudget(1000)
            await reconcileOwnerFollowers(
                { ...ownerDeps(obj, budget), followed: obj, budget },
                null,
                10
            )
            expect(ownerFollowers(obj, "did:s")).toBe(0)
            expect(await obj.inInterest("did:s")).toBe(false)
        })
    })

    it("the owner_followers reconcile does not finish a pass it had no budget for", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            seedFollowee(obj, "did:s", 1)
            const step = (budget: StatementBudget) =>
                (
                    obj as unknown as {
                        reconcileOwnerFollowerCounts(d: unknown): Promise<void>
                    }
                ).reconcileOwnerFollowerCounts({ ...ownerDeps(obj, budget), followed: obj, budget })
            const done = () =>
                rowsOf<{ v: string }>(obj, "SELECT v FROM meta WHERE k = 'owner_followers_done'")[0]
            await expect(step(statementBudget(0))).rejects.toThrow(/budget/)
            expect(done()).toBeUndefined()
            await step(statementBudget(1000))
            expect(ownerFollowers(obj, "did:s")).toBe(0)
            expect(done()).toBeDefined()
        })
    })

    it("a subject re-queued during the drain stays queued", async () => {
        const s = registeredStub()
        await inObj(s, async (obj) => {
            await obj.queueRecount(["did:a"], 1)
            const budget = statementBudget(1000)
            const deps = { ...ownerDeps(obj, budget), queue: obj, budget }
            const followersOf = deps.edges.followersOf.bind(deps.edges)
            deps.edges.followersOf = async (subjects) => {
                await obj.queueRecount(["did:a"], 1)
                return followersOf(subjects)
            }
            await drainRecounts(deps, 10)
            expect(queued(obj)).toEqual(["did:a"])
        })
    })
})
