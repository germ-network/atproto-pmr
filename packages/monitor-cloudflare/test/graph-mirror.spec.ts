/**
 * The edge index's copy of who is served, who holds a declaration and who is
 * in interest, pushed from the single writer's state by the alarm.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
    mirrorGraph,
    pruneGraphChanges,
    reconcileGraphMirror,
    type GraphMirrorDeps,
    type MirrorReconcileCursor,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv & {
    pmrDirectory: KVNamespace
    graph: D1Database
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
const db = testEnv.graph

let n = 0
const stub = () => {
    n += 1
    const ns = testEnv.ingestRegistered
    return ns.get(ns.idFromName(`graph-mirror-${n}`))
}
const inObj = <R>(s: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(s, (obj) => fn(obj as MonitorIngest))

/** List `did` in the relay's directory, so the daily registration reconcile keeps it. */
const listedDids = new Set<string>()
const listed = (...dids: string[]) =>
    Promise.all(
        dids.map((d) => {
            listedDids.add(d)
            return testEnv.pmrDirectory.put(d, "1")
        })
    )

const deps = (obj: MonitorIngest, database: D1Database = db): GraphMirrorDeps => ({
    index: obj,
    edges: d1FollowEdgeWriter(database, statementBudget(1000)),
    nowMs: () => Date.now(),
})

/** One alarm with the network stubbed out; the connect stages fail, the rest runs. */
async function alarm(s: DurableObjectStub<MonitorIngest>) {
    await inObj(s, (obj) => (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog())
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
    try {
        await runDurableObjectAlarm(s)
    } catch (err) {
        // connect() has no real socket to open here.
        if (!/did not upgrade/.test(String(err))) throw err
    } finally {
        globalThis.fetch = original
    }
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return (await db.prepare(sql).bind(...binds).all<T>()).results
}
const dids = async (table: string) =>
    (await all<{ did: string }>(`SELECT did FROM ${table} ORDER BY did`)).map((r) => r.did)
const edgeCount = async (follower: string) =>
    (await all<{ n: number }>("SELECT COUNT(*) AS n FROM follows WHERE follower = ?", follower))[0]!.n

const putEdge = (follower: string, rkey: string, subject: string) =>
    db
        .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, 1)")
        .bind(follower, rkey, subject)
        .run()
const sql = (obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    (obj as unknown as { db: DurableObjectStorage }).db.sql.exec(query, ...binds)
/** Pretend `mirrored` was last pushed for `did`, as nothing in this layer serves an owner. */
const setMirrored = (
    obj: MonitorIngest,
    did: string,
    f: { owner?: number; holder?: number; member?: number; registered?: number }
) =>
    sql(
        obj,
        "INSERT OR REPLACE INTO graph_mirrored (did, owner, holder, member, registered) VALUES (?, ?, ?, ?, ?)",
        did,
        f.owner ?? 0,
        f.holder ?? 0,
        f.member ?? 0,
        f.registered ?? 0
    )

beforeEach(async () => {
    await Promise.all([...listedDids].map((d) => testEnv.pmrDirectory.delete(d)))
    listedDids.clear()
    await db.batch(
        ["follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("graph mirror", () => {
    it("an owner whose first listing has not completed is not served", async () => {
        const s = stub()
        await listed("did:plc:owner")
        await inObj(s, (obj) => obj.setRegistered("did:plc:owner", true, 1))
        await alarm(s)
        // A registered user is a graph owner, but nothing has listed it.
        expect(await dids("interest")).toEqual(["did:plc:owner"])
        expect(await all("SELECT registered FROM interest")).toEqual([{ registered: 1 }])
        expect(await dids("graph_owners")).toEqual([])
        await inObj(s, async (obj) => {
            expect(await obj.dueMirror(10)).toEqual([])
        })
    })

    it("a removed owner is mirrored and its owner rows pruned", async () => {
        const s = stub()
        await db.batch([
            db.prepare("INSERT INTO graph_owners (did) VALUES ('did:o')"),
            db.prepare("INSERT INTO interest (did, registered) VALUES ('did:o', 1)"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:h')"),
        ])
        await putEdge("did:o", "1", "did:h")
        await putEdge("did:o", "2", "did:plain")
        await inObj(s, async (obj) => {
            setMirrored(obj, "did:o", { owner: 1, member: 1, registered: 1 })
            expect(await mirrorGraph(deps(obj), 10)).toBe(1)
        })
        expect(await dids("graph_owners")).toEqual([])
        expect(await edgeCount("did:o")).toBe(0)
    })

    it("a DID leaving interest has its mutual-hint rows pruned", async () => {
        const s = stub()
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:m', 0)").run()
        await db.prepare("INSERT INTO graph_holders (did) VALUES ('did:reg')").run()
        await putEdge("did:m", "1", "did:reg")
        await inObj(s, async (obj) => {
            setMirrored(obj, "did:m", { member: 1 })
            await mirrorGraph(deps(obj), 10)
            expect(await obj.dueMirror(10)).toEqual([])
        })
        expect(await dids("interest")).toEqual([])
        expect(await edgeCount("did:m")).toBe(0)
    })

    it("a non-owner whose holder flag changes keeps its edges", async () => {
        const s = stub()
        await db.batch([
            db.prepare("INSERT INTO interest (did, registered) VALUES ('did:x', 0)"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:x')"),
        ])
        await putEdge("did:x", "1", "did:y")
        await inObj(s, async (obj) => {
            // Still in interest (member), no longer a holder.
            sql(obj, "INSERT INTO interest (did, member) VALUES ('did:x', 1)")
            setMirrored(obj, "did:x", { holder: 1, member: 1 })
            await mirrorGraph(deps(obj), 10)
        })
        expect(await dids("graph_holders")).toEqual([])
        expect(await dids("interest")).toEqual(["did:x"])
        expect(await edgeCount("did:x")).toBe(1)
    })

    it("a mirror retried after its batch committed still prunes the removed owner", async () => {
        const s = stub()
        await db.batch([
            db.prepare("INSERT INTO graph_owners (did) VALUES ('did:o')"),
            db.prepare("INSERT INTO interest (did, registered) VALUES ('did:o', 1)"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:h')"),
        ])
        await putEdge("did:o", "1", "did:h")
        await inObj(s, async (obj) => {
            setMirrored(obj, "did:o", { owner: 1, member: 1, registered: 1 })
            const [due] = await obj.dueMirror(10)
            // The batch commits; the object is evicted before markMirrored.
            await deps(obj).edges.mirror([due!])
            expect(await edgeCount("did:o")).toBe(0)
            // Edges written for the follower in the meantime, then the retry.
            expect(await obj.dueMirror(10)).toHaveLength(1)
            await mirrorGraph(deps(obj), 10)
            expect(await obj.dueMirror(10)).toEqual([])
        })
        expect(await dids("graph_owners")).toEqual([])
        expect(await dids("interest")).toEqual([])
    })

    it("a holder whose leave dropped its holder_state is mirrored out", async () => {
        const s = stub()
        await db.batch([
            db.prepare("INSERT INTO interest (did, registered) VALUES ('did:gone', 0)"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:gone')"),
        ])
        await inObj(s, async (obj) => {
            // The DO has no holder_state or interest row for it any more.
            setMirrored(obj, "did:gone", { holder: 1, member: 1 })
            const [due] = await obj.dueMirror(10)
            expect(due!.now).toEqual({
                did: "did:gone",
                owner: false,
                holder: false,
                member: false,
                registered: false,
            })
            await mirrorGraph(deps(obj), 10)
            expect(await obj.dueMirror(10)).toEqual([])
            expect((await obj.mirroredPage(null, 10)).rows).toEqual([])
        })
        expect(await dids("graph_holders")).toEqual([])
        expect(await dids("interest")).toEqual([])
    })

    it("reconcile repairs a missed add or remove", async () => {
        const s = stub()
        // D1 holds a DID the single writer never mirrored (a missed remove),
        // and lacks one it did (a missed add).
        await db.batch([
            db.prepare("INSERT INTO interest (did, registered) VALUES ('did:stale', 0)"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:stale')"),
        ])
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:missed", true, 1)
            await obj.markMirrored([
                { did: "did:missed", owner: false, holder: false, member: true, registered: true },
            ])
            let cursor: MirrorReconcileCursor | null = null
            let pages = 0
            do {
                cursor = await reconcileGraphMirror(deps(obj), cursor, 1)
                pages += 1
            } while (cursor !== null && pages < 20)
            expect(cursor).toBeNull()
        })
        expect(await dids("interest")).toEqual(["did:missed"])
        expect(await all("SELECT registered FROM interest")).toEqual([{ registered: 1 }])
        expect(await dids("graph_holders")).toEqual([])
    })

    it("change rows older than retention are pruned in bounded chunks", async () => {
        const s = stub()
        const old = Date.now() - 8 * 86_400_000
        await db.batch([
            ...[1, 2, 3, 4, 5].map((i) =>
                db
                    .prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES (?, 'following', ?)")
                    .bind(`did:old${i}`, old)
            ),
            db
                .prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES ('did:new', 'following', ?)")
                .bind(Date.now()),
        ])
        await inObj(s, async (obj) => {
            expect(await pruneGraphChanges(deps(obj), 2)).toBe(2)
            expect(await pruneGraphChanges(deps(obj), 2)).toBe(2)
            expect(await pruneGraphChanges(deps(obj), 2)).toBe(1)
            expect(await pruneGraphChanges(deps(obj), 2)).toBe(0)
        })
        expect(await all<{ did: string }>("SELECT did FROM graph_changes")).toEqual([{ did: "did:new" }])
    })

    it("a failing mirror step does not stop the re-arm", async () => {
        const s = stub()
        await listed("did:plc:a")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            const broken = {
                prepare: () => {
                    throw new Error("d1 is down")
                },
                batch: () => Promise.reject(new Error("d1 is down")),
            }
            obj.env = { ...obj.env, graph: broken as unknown as D1Database }
        })
        await alarm(s)
        await runInDurableObject(s, async (_obj, state) => {
            const at = await state.storage.getAlarm()
            // The watchdog interval, not a retry the runtime scheduled itself.
            const interval = Number(testEnv.WATCHDOG_INTERVAL_MS)
            expect(at).not.toBeNull()
            expect(at! - Date.now()).toBeGreaterThan(interval - 30_000)
        })
        // Nothing was mirrored, so it is still due.
        await inObj(s, async (obj) => {
            expect(await obj.dueMirror(10)).toHaveLength(1)
        })
    })

    it("a standing change during the mirror's batch is mirrored on the next alarm", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            let changed = false
            const racing = {
                prepare: (q: string) => db.prepare(q),
                batch: async (statements: D1PreparedStatement[]) => {
                    const result = await db.batch(statements)
                    if (!changed) {
                        changed = true
                        // An RPC lands while the batch is in flight.
                        await obj.setRegistered("did:plc:a", false, 2)
                    }
                    return result
                },
            } as unknown as D1Database
            await mirrorGraph(deps(obj, racing), 10)
            expect(await dids("interest")).toEqual(["did:plc:a"])
            const [due] = await obj.dueMirror(10)
            expect(due!.mirrored).toMatchObject({ did: "did:plc:a", member: true, registered: true })
            expect(due!.now).toMatchObject({ member: false, registered: false })
            await mirrorGraph(deps(obj), 10)
            expect(await obj.dueMirror(10)).toEqual([])
        })
        expect(await dids("interest")).toEqual([])
    })

    it("a flag that flips back after an unrecorded commit is mirrored on the next pass", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            await mirrorGraph(deps(obj), 10)
            await obj.setRegistered("did:plc:a", false, 2)
            // The removal commits in D1, but the object never records it.
            await deps(obj).edges.mirror(await obj.dueMirror(10))
            expect(await dids("interest")).toEqual([])
            await obj.setRegistered("did:plc:a", true, 3)
            await mirrorGraph(deps(obj), 10)
        })
        expect(await dids("interest")).toEqual(["did:plc:a"])
    })

    it("a change in the registered flag alone is mirrored", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers("did:plc:f", 1, 1)
            await mirrorGraph(deps(obj), 10)
            expect(await all("SELECT registered FROM interest")).toEqual([{ registered: 0 }])
            await obj.setRegistered("did:plc:f", true, 2)
            await mirrorGraph(deps(obj), 10)
        })
        expect(await all("SELECT registered FROM interest")).toEqual([{ registered: 1 }])
    })

    it("reconcile pages the single writer's rows past the first page", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            for (const d of ["did:a", "did:b"]) {
                await obj.setRegistered(d, true, 1)
                await obj.markMirrored([
                    { did: d, owner: false, holder: false, member: true, registered: true },
                ])
            }
            let cursor: MirrorReconcileCursor | null = null
            do cursor = await reconcileGraphMirror(deps(obj), cursor, 1)
            while (cursor !== null)
        })
        expect(await dids("interest")).toEqual(["did:a", "did:b"])
    })

    it("the daily reconcile runs once a day and clears its cursor when a pass completes", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            const step = (nowMs: number) =>
                (
                    obj as unknown as {
                        reconcileGraph(d: GraphMirrorDeps & { budget: unknown }): Promise<void>
                    }
                ).reconcileGraph({ ...deps(obj), nowMs: () => nowMs, budget: statementBudget(1000) })
            const meta = (k: string) =>
                sql(obj, "SELECT v FROM meta WHERE k = ?", k).toArray()
            const t = Date.now()
            await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:o1', 0)").run()
            await step(t)
            expect(meta("graph_reconcile_cursor")).toHaveLength(1)
            await step(t)
            expect(meta("graph_reconcile_cursor")).toHaveLength(0)
            expect(meta("graph_reconcile_done")).toHaveLength(1)
            expect(await dids("interest")).toEqual([])
            // Done today: a new orphan waits for tomorrow's pass.
            await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:o2', 0)").run()
            await step(t + 3_600_000)
            await step(t + 3_600_000)
            expect(await dids("interest")).toEqual(["did:o2"])
            await step(t + 86_400_000 + 1)
            await step(t + 86_400_000 + 1)
            expect(await dids("interest")).toEqual([])
        })
    })

    it("each graph step fails alone", async () => {
        const s = stub()
        const old = Date.now() - 8 * 86_400_000
        await db.batch([
            db.prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES ('did:old', 'following', ?)").bind(old),
            db.prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES ('did:new', 'following', ?)").bind(Date.now()),
        ])
        await listed("did:plc:a")
        await inObj(s, async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            const writesFail = {
                prepare: (q: string) => db.prepare(q),
                batch: () => Promise.reject(new Error("batch down")),
            }
            obj.env = { ...obj.env, graph: writesFail as unknown as D1Database }
        })
        await alarm(s)
        // The mirror's batch failed; the prune still ran.
        expect(await all<{ did: string }>("SELECT did FROM graph_changes")).toEqual([{ did: "did:new" }])
    })

    it("the alarm mirrors, prunes and reconciles", async () => {
        const s = stub()
        await listed("did:plc:a")
        await inObj(s, (obj) => obj.setRegistered("did:plc:a", true, 1))
        await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:orphan', 0)").run()
        await alarm(s)
        expect(await dids("interest")).toEqual(["did:orphan", "did:plc:a"])
        // The first alarm paged the single writer's side; the second found the
        // orphan D1 holds and the DO does not.
        await alarm(s)
        await inObj(s, async (obj) => {
            const cursor = (obj as unknown as { db: DurableObjectStorage }).db.sql
                .exec("SELECT v FROM meta WHERE k = 'graph_reconcile_done'")
                .toArray()
            expect(cursor).toHaveLength(1)
        })
        expect(await dids("interest")).toEqual(["did:plc:a"])
    })
})
