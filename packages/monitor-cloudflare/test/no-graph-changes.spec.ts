/** The follow-edge index keeps no change log: nothing writes, prunes or reads one. */
import { beforeEach, describe, expect, it } from "vitest"
import { flushStatements, worstCaseDrainStatements, type GraphMirrorTransition } from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import * as exported from "../src/index"
import { alarm, all, clearGraph, db, inObj, registeredStub, setEnv } from "./listing-harness"

beforeEach(clearGraph)

/** `db` with every prepared statement's SQL recorded. */
function recording(): { db: D1Database; sql: string[] } {
    const sql: string[] = []
    const wrapped = new Proxy(db, {
        get(target, prop) {
            if (prop === "prepare") {
                return (query: string) => {
                    sql.push(query)
                    return target.prepare(query)
                }
            }
            const value = Reflect.get(target, prop, target)
            return typeof value === "function" ? value.bind(target) : value
        },
    })
    return { db: wrapped, sql }
}

const flags = (did: string, owner: boolean, holder: boolean, member: boolean) => ({
    did,
    owner,
    holder,
    member,
    registered: false,
})
const gone = flags("did:m", false, false, false)
const present = flags("did:m", true, true, true)

describe("no graph change log", () => {
    it("putEdges, deleteEdges, sweep, pruneFollower and mirror send no statement naming graph_changes", async () => {
        await db.batch([
            db.prepare("INSERT INTO graph_owners (did) VALUES ('did:a')"),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:s')"),
        ])
        const rec = recording()
        const w = d1FollowEdgeWriter(rec.db, statementBudget(1000))
        await w.putEdges([{ follower: "did:a", rkey: "1", subject: "did:s" }], 1)
        await w.putEdges([{ follower: "did:a", rkey: "2", subject: "did:s" }], 2)
        await w.sweep("did:a", 2)
        await w.deleteEdges([{ follower: "did:a", rkey: "2" }])
        await w.putEdges([{ follower: "did:a", rkey: "3", subject: "did:s" }], 3)
        await w.pruneFollower("did:a")
        const transitions: GraphMirrorTransition[] = [
            { now: present, mirrored: null },
            { now: gone, mirrored: present },
        ]
        await w.mirror(transitions)
        expect(rec.sql.length).toBeGreaterThan(10)
        expect(rec.sql.filter((s) => s.includes("graph_changes"))).toEqual([])
    })

    it("a mirror batch is sized at five statements per DID", async () => {
        const s = registeredStub("nc")
        const limit = await inObj(s, async (obj) => {
            setEnv(obj, { GRAPH_MIRROR_BATCH: "200", GRAPH_STATEMENT_BUDGET: "1000" })
            const seen: number[] = []
            const original = obj.dueMirror.bind(obj)
            obj.dueMirror = (n: number) => {
                seen.push(n)
                return original(n)
            }
            return seen
        })
        await alarm(s)
        expect(limit[0]).toBe(120)
    })

    it("a full flush chunk and a full mixed drain chunk charge exactly their worst-case counts", async () => {
        const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ follower: "did:a", rkey: `r${i}` }))
        const edges = (n: number) => refs(n).map((r) => ({ ...r, subject: "did:s" }))
        const spent = async (fn: (w: ReturnType<typeof d1FollowEdgeWriter>, b: ReturnType<typeof d1BlockEdgeWriter>) => Promise<void>) => {
            const budget = statementBudget(1000)
            await fn(d1FollowEdgeWriter(db, budget), d1BlockEdgeWriter(db, budget))
            return 1000 - budget.remaining
        }
        expect(await spent((w) => w.putEdges(edges(25), 1).then(() => undefined))).toBe(
            flushStatements(25, 0, 0, 0)
        )
        expect(await spent((w) => w.deleteEdges(refs(25)).then(() => undefined))).toBe(
            flushStatements(0, 25, 0, 0)
        )
        expect(
            await spent(async (w, b) => {
                await w.putEdges(edges(24), 2)
                await b.putBlocks([{ blocker: "did:a", rkey: "b", subject: "did:x" }], 2)
            })
        ).toBe(flushStatements(24, 0, 1, 0))
        // A mixed drain chunk is the puts plus the follow and block sweeps.
        expect(
            await spent(async (w, b) => {
                await w.putEdges(edges(24), 3)
                await b.putBlocks([{ blocker: "did:a", rkey: "b", subject: "did:x" }], 3)
                await b.sweepBlocks("did:a", 3)
                await w.sweep("did:a", 3)
            })
        ).toBe(worstCaseDrainStatements(25, true))
    })

    it("the migrated schema has no graph_changes table", async () => {
        const tables = await all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name LIKE 'graph_changes%'"
        )
        expect(tables).toEqual([])
    })

    it("monitor-cloudflare exports no d1GraphChangeLog", () => {
        expect(exported).not.toHaveProperty("d1GraphChangeLog")
    })
})
