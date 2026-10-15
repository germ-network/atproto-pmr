/** Listings write and sweep a DID's kept blocks alongside its follows. */
import { beforeEach, describe, expect, it } from "vitest"
import { flushEdgeOps, worstCaseDrainStatements } from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"
import {
    all,
    clearGraph,
    db,
    drainAll,
    entriesOf,
    inObj,
    queuedDids,
    registeredStub,
    rkeyOf,
    rowsOf,
    setEnv,
    sql,
    step,
    stubNet,
} from "./listing-harness"

beforeEach(async () => {
    await clearGraph()
    await db.exec("DELETE FROM blocks")
})

const O = "did:plc:owner"
const M = "did:plc:mutual"

const blocksOf = (blocker: string) =>
    all<{ rkey: string; subject: string; gen: number }>(
        "SELECT rkey, subject, gen FROM blocks WHERE blocker = ? ORDER BY rkey",
        blocker
    )
const pagedOwner = (obj: MonitorIngest) => {
    sql(obj, "INSERT INTO listings (did, paged) VALUES (?, 1) ON CONFLICT(did) DO UPDATE SET paged = 1", O)
}
const flush = (obj: MonitorIngest) =>
    flushEdgeOps(
        {
            ops: obj,
            edges: d1FollowEdgeWriter(db, statementBudget(1000)),
            blocks: d1BlockEdgeWriter(db, statementBudget(1000)),
            budget: statementBudget(1000),
            interest: obj,
        },
        1000
    )

describe("listings — blocks", () => {
    it("an owner-repo listing writes the owner's blocks from the same getRepo as its follows", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.register(O)
            const net = stubNet(obj, {
                repos: { [O]: entriesOf(2) },
                blockRepos: { [O]: entriesOf(3, (i) => `did:plc:x${i}`) },
            })
            expect(await step(obj)).toEqual(["listed"])
            expect(net.repoFetches).toEqual([O])
        })
        const rows = await blocksOf(O)
        expect(rows.map((r) => [r.rkey, r.subject])).toEqual([
            [rkeyOf(0), "did:plc:x0"],
            [rkeyOf(1), "did:plc:x1"],
            [rkeyOf(2), "did:plc:x2"],
        ])
        const follows = await all<{ gen: number }>("SELECT gen FROM follows WHERE follower = ?", O)
        expect(follows.map((f) => f.gen)).toEqual([rows[0]!.gen, rows[0]!.gen])
    })

    it("an owner-repo walk past MAX_BLOCKS switches the owner to pages", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            setEnv(obj, { MAX_BLOCKS: "2" })
            await obj.register(O)
            stubNet(obj, {
                repos: { [O]: entriesOf(1) },
                blockRepos: { [O]: entriesOf(3) },
                lists: { [O]: entriesOf(1) },
                blockLists: { [O]: entriesOf(3) },
            })
            expect(await step(obj)).toEqual(["switched-to-paged"])
            expect(await step(obj)).toEqual(["listed"])
        })
        expect(await blocksOf(O)).toHaveLength(3)
    })

    it("a paged-owner listing lists blocks by listRecords after its follows", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.register(O)
            pagedOwner(obj)
            const net = stubNet(obj, {
                lists: { [O]: entriesOf(3) },
                blockLists: { [O]: entriesOf(3, (i) => `did:plc:x${i}`) },
                pageSize: 2,
            })
            expect(await step(obj)).toEqual(["listed"])
            const order = net.pages.map((p) => p.collection)
            expect(order).toContain("block")
            expect(order.slice(0, order.indexOf("block")).every((c) => c === "follow")).toBe(true)
            expect(net.pages.find((p) => p.collection === "block")!.cursor).toBeNull()
        })
        expect((await blocksOf(O)).map((r) => r.subject)).toEqual(["did:plc:x0", "did:plc:x1", "did:plc:x2"])
    })

    it("a mutual listing keeps only blocks whose subject is registered", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            await obj.register("did:plc:r1")
            stubNet(obj, {
                blockLists: {
                    [M]: [
                        { rkey: "a", subject: "did:plc:nobody" },
                        { rkey: "b", subject: "did:plc:r1" },
                    ],
                },
            })
            expect(await step(obj)).toContain("listed")
        })
        expect((await blocksOf(M)).map((r) => r.rkey)).toEqual(["b"])
    })

    it("a completed listing sweeps blocks the repo no longer has", async () => {
        const s = registeredStub("b")
        await db.prepare("INSERT INTO blocks (blocker, rkey, subject, gen) VALUES (?, 'old', 'did:plc:o', 0)").bind(O).run()
        await db.prepare("INSERT INTO blocks (blocker, rkey, subject, gen) VALUES ('did:plc:other', 'old', 'did:plc:o', 0)").run()
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: [] }, blockRepos: { [O]: entriesOf(1) } })
            await step(obj)
        })
        expect((await blocksOf(O)).map((r) => r.rkey)).toEqual([rkeyOf(0)])
        expect(await blocksOf("did:plc:other")).toHaveLength(1)
    })

    it("a live block op logged after the listing began survives its drain and sweep", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(3000) }, blockRepos: { [O]: entriesOf(3000, (i) => `did:plc:x${i}`) } })
            expect(await step(obj)).toEqual(["in-progress"])
            await obj.logEdgeOp(
                { collection: "block", kind: "create", follower: O, rkey: "live", subject: "did:plc:live", rev: "r", cursor: "1" },
                "1"
            )
            await obj.logEdgeOp(
                { collection: "block", kind: "delete", follower: O, rkey: rkeyOf(2990), rev: "r", cursor: "1" },
                "1"
            )
            await flush(obj)
            expect(
                rowsOf(obj, "SELECT 1 FROM listing_stage WHERE did = ? AND collection = 'block' AND rkey = ?", O, rkeyOf(2990))
            ).toEqual([])
            await drainAll(obj)
        })
        const rows = await blocksOf(O)
        expect(rows.find((r) => r.rkey === "live")?.subject).toBe("did:plc:live")
        expect(rows.some((r) => r.rkey === rkeyOf(2990))).toBe(false)
        expect(rows).toHaveLength(3000)
    })

    it("a follow and a block sharing an rkey stage, drain and sweep independently", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, {
                repos: { [O]: entriesOf(3000, (i) => `did:plc:f${i}`) },
                blockRepos: { [O]: entriesOf(3000, (i) => `did:plc:b${i}`) },
            })
            expect(await step(obj)).toEqual(["in-progress"])
            await drainAll(obj)
        })
        const follows = await all<{ rkey: string; subject: string }>(
            "SELECT rkey, subject FROM follows WHERE follower = ? ORDER BY rkey",
            O
        )
        const rows = await blocksOf(O)
        expect(follows).toHaveLength(3000)
        expect(rows).toHaveLength(3000)
        expect(follows.every((f, i) => f.rkey === rows[i]!.rkey && f.subject !== rows[i]!.subject)).toBe(true)
    })

    it("a DID the owner only blocks is not queued for a followee listing", async () => {
        const s = registeredStub("b")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(M, 1, 1)
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, {
                repos: { [O]: [] },
                blockRepos: { [O]: [{ rkey: "a", subject: M }] },
            })
            await obj.queueListing(O, Date.now(), "join")
            await step(obj)
            expect(queuedDids(obj)).toEqual([])
        })
    })

    it("worstCaseDrainStatements covers a drain of follows and blocks with both sweeps", async () => {
        for (const [follows, blocks] of [
            [24, 1],
            [1, 24],
            [60, 60],
            [26, 3],
        ] as const) {
            const s = registeredStub("b")
            const budget = statementBudget(400)
            await inObj(s, async (obj) => {
                await clearGraph()
                await obj.register(O)
                stubNet(obj, { repos: { [O]: entriesOf(follows) }, blockRepos: { [O]: entriesOf(blocks) } })
                expect(await step(obj, { budget })).toEqual(["listed"])
            })
            expect(400 - budget.remaining).toBeLessThanOrEqual(worstCaseDrainStatements(follows + blocks, true))
            expect(await blocksOf(O)).toHaveLength(blocks)
        }
    })
})
