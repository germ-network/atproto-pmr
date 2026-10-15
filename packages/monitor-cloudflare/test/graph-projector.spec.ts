/**
 * The ingest object keeps the projector's cursor and answers servedness from
 * the standing it last mirrored, and the alarm runs the projector after the
 * mirror.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runGraphProjector } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeStore, d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import { d1GraphChangeLog } from "../src/graph-change-log"
import { kvGraphProjections } from "../src/graph-projection-store"
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
    return ns.get(ns.idFromName(`graph-projector-${n}`))
}
const inObj = <R>(s: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(s, (obj) => fn(obj as MonitorIngest))
const sql = (obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    (obj as unknown as { db: DurableObjectStorage }).db.sql.exec(query, ...binds)

const listedDids = new Set<string>()
const listed = (...dids: string[]) =>
    Promise.all(
        dids.map((d) => {
            listedDids.add(d)
            return testEnv.pmrDirectory.put(d, "1")
        })
    )

/** A registered DID whose owner listing has completed: its graph is served once mirrored. */
async function serveOwner(obj: MonitorIngest, did: string): Promise<void> {
    await obj.setRegistered(did, true, 1)
    sql(obj, "INSERT OR REPLACE INTO listings (did, listed_at, owner_listed_at) VALUES (?, 1, 1)", did)
}

const projectionKey = (did: string) => `graph:${did}`
const held = async (did: string) => (await testEnv.records.get(projectionKey(did))) !== null

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

const projectorDeps = (obj: MonitorIngest) => ({
    index: obj,
    changes: d1GraphChangeLog(db),
    edges: d1FollowEdgeStore(db),
    projections: kvGraphProjections(testEnv),
    budget: statementBudget(1000),
})

beforeEach(async () => {
    await Promise.all([...listedDids].map((d) => testEnv.pmrDirectory.delete(d)))
    listedDids.clear()
    await db.batch(
        ["follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("MonitorIngest graph projector", () => {
    it("the projector cursor round-trips through storage, null when never set", async () => {
        await inObj(stub(), async (obj) => {
            expect(await obj.projectorCursor()).toBeNull()
            await obj.setProjectorCursor({ kind: "tail", seq: 7 })
            expect(await obj.projectorCursor()).toEqual({ kind: "tail", seq: 7 })
            const rebuild = { kind: "rebuild", asOfSeq: 9, phase: "sweep", page: "did:x" } as const
            await obj.setProjectorCursor(rebuild)
            expect(await obj.projectorCursor()).toEqual(rebuild)
        })
    })

    it("mirroredGraphStanding follows graph_mirrored (owner, inflight), not the live standing", async () => {
        await inObj(stub(), async (obj) => {
            const mirrored = (did: string, owner: number, inflight: number) =>
                sql(
                    obj,
                    "INSERT OR REPLACE INTO graph_mirrored (did, owner, holder, member, registered, inflight) " +
                        "VALUES (?, ?, 0, 0, 0, ?)",
                    did,
                    owner,
                    inflight
                )
            mirrored("did:served", 1, 0)
            mirrored("did:not", 0, 0)
            mirrored("did:flying", 1, 1)
            mirrored("did:flying-new", 0, 1)
            expect(await obj.mirroredGraphStanding("did:served")).toBe("served")
            expect(await obj.mirroredGraphStanding("did:not")).toBe("not-served")
            expect(await obj.mirroredGraphStanding("did:flying")).toBe("in-flight")
            expect(await obj.mirroredGraphStanding("did:flying-new")).toBe("in-flight")
            expect(await obj.mirroredGraphStanding("did:unknown")).toBe("not-served")
            // The live standing leads the mirror: ownership alone changes nothing here.
            await serveOwner(obj, "did:unknown")
            expect(await obj.mirroredGraphStanding("did:unknown")).toBe("not-served")
        })
    })

    it("servedGraphsMirrored pages mirrored owners and in-flight rows by DID", async () => {
        await inObj(stub(), async (obj) => {
            for (const [did, owner, inflight] of [
                ["did:a", 1, 0],
                ["did:b", 0, 0],
                ["did:c", 0, 1],
                ["did:d", 1, 0],
                ["did:e", 1, 1],
            ] as const) {
                sql(
                    obj,
                    "INSERT INTO graph_mirrored (did, owner, holder, member, registered, inflight) " +
                        "VALUES (?, ?, 0, 0, 0, ?)",
                    did,
                    owner,
                    inflight
                )
            }
            const first = await obj.servedGraphsMirrored(null, 2)
            expect(first).toEqual({ dids: ["did:a", "did:c"], cursor: "did:c" })
            const second = await obj.servedGraphsMirrored(first.cursor, 2)
            expect(second).toEqual({ dids: ["did:d", "did:e"], cursor: null })
        })
    })

    it("a served-add whose markMirrored failed is projected on a later alarm", async () => {
        const s = stub()
        const did = "did:plc:unrecorded"
        await listed(did)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await inObj(s, async (obj) => {
                await serveOwner(obj, did)
                // The batch commits in D1; the object never records it.
                await d1FollowEdgeWriter(db, statementBudget(1000)).mirror(await obj.dueMirror(10))
                expect(await obj.mirroredGraphStanding(did)).toBe("in-flight")
                await runGraphProjector(projectorDeps(obj), 10)
            })
            expect(await held(did)).toBe(false)
            await alarm(s)
            expect(await held(did)).toBe(true)
        } finally {
            warn.mockRestore()
        }
    })

    it("an alarm after a served-add projects the owner's graph into graph:<did>", async () => {
        const s = stub()
        const did = "did:plc:owner-projected"
        await listed(did)
        await inObj(s, (obj) => serveOwner(obj, did))
        await alarm(s)
        expect(await held(did)).toBe(true)
        // The rebuild's sweep runs on the next alarm, then tailing resumes.
        await alarm(s)
        await inObj(s, async (obj) => {
            expect(await obj.projectorCursor()).toMatchObject({ kind: "tail" })
        })
        expect(await kvGraphProjections(testEnv).get(did)).toEqual({ did, following: [], followers: [] })
    })

    it("an alarm after a served-remove deletes graph:<did>", async () => {
        const s = stub()
        const did = "did:plc:owner-removed"
        await listed(did)
        await inObj(s, (obj) => serveOwner(obj, did))
        await alarm(s)
        expect(await held(did)).toBe(true)
        await inObj(s, (obj) => obj.setRegistered(did, false, 2))
        await alarm(s)
        expect(await held(did)).toBe(false)
    })

    it("a projector failure does not stop the later graph steps or the re-arm", async () => {
        const s = stub()
        const did = "did:plc:projector-fails"
        const old = Date.now() - 8 * 86_400_000
        await db.batch([
            db
                .prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES ('did:old', 'following', ?)")
                .bind(old),
            db
                .prepare("INSERT INTO graph_changes (did, reason, at_ms) VALUES ('did:new', 'following', ?)")
                .bind(Date.now()),
        ])
        await listed(did)
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        try {
            await inObj(s, async (obj) => {
                await serveOwner(obj, did)
                const records = obj.env.records
                const brokenRecords = {
                    get: (...a: Parameters<KVNamespace["get"]>) => (records.get as Function)(...a),
                    list: (...a: Parameters<KVNamespace["list"]>) => records.list(...a),
                    put: (key: string, ...rest: unknown[]) =>
                        key.startsWith("graph:")
                            ? Promise.reject(new Error("kv down"))
                            : (records.put as Function)(key, ...rest),
                    delete: (key: string) =>
                        key.startsWith("graph:")
                            ? Promise.reject(new Error("kv down"))
                            : records.delete(key),
                }
                obj.env = { ...obj.env, records: brokenRecords as unknown as KVNamespace }
            })
            await alarm(s)
            expect(error.mock.calls.some((c) => String(c[0]).includes("graph projector failed"))).toBe(true)
        } finally {
            error.mockRestore()
        }
        // The prune after the projector still ran, and the watchdog re-armed.
        const rows = (await db.prepare("SELECT did FROM graph_changes WHERE did LIKE 'did:%' ORDER BY seq").all<{ did: string }>()).results
        expect(rows.map((r) => r.did)).not.toContain("did:old")
        await runInDurableObject(s, async (_obj, state) => {
            expect(await state.storage.getAlarm()).not.toBeNull()
        })
    })
})
