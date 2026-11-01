/** A DID's block rows follow the same mirror transitions as its follows. */
import { beforeEach, describe, expect, it } from "vitest"
import type { GraphMirrorRow, GraphMirrorTransition } from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeStore } from "../src/block-edge-store"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import {
    all,
    blocksOf,
    clearGraph,
    db,
    inObj,
    registeredStub,
    step,
    stubNet,
} from "./listing-harness"

beforeEach(async () => {
    await clearGraph()
    await db.exec("DELETE FROM blocks")
})

const none: GraphMirrorRow = { did: "", owner: false, holder: false, member: false, registered: false }
const row = (did: string, flags: Partial<GraphMirrorRow>): GraphMirrorRow => ({ ...none, did, ...flags })
const mirror = (budget: number, ...transitions: GraphMirrorTransition[]) =>
    d1FollowEdgeWriter(db, statementBudget(budget)).mirror(transitions)
const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
const putBlock = (blocker: string, rkey: string, subject: string) =>
    run("INSERT INTO blocks (blocker, rkey, subject, gen) VALUES (?, ?, ?, 1)", blocker, rkey, subject)

describe("graph mirror — blocks", () => {
    it("prunes a DID's blocks when it leaves interest", async () => {
        await run("INSERT INTO interest (did, registered) VALUES ('did:m', 0)")
        await run("INSERT INTO interest (did, registered) VALUES ('did:reg', 1)")
        await putBlock("did:m", "1", "did:reg")
        await putBlock("did:other", "1", "did:reg")
        const store = d1BlockEdgeStore(db)
        expect(await store.isBlocked("did:m", "did:reg")).toBe(true)
        const leaves = { now: row("did:m", {}), mirrored: row("did:m", { member: true }) }
        // A pruning transition spends exactly the per-DID statements the alarm budgets for.
        await expect(mirror(4, leaves)).rejects.toThrow(/budget/)
        await mirror(5, leaves)
        expect(await blocksOf("did:m")).toEqual([])
        expect(await blocksOf("did:other")).toHaveLength(1)
        expect(await store.isBlocked("did:m", "did:reg")).toBe(false)
    })

    it("prunes all of a DID's blocks when its graph stops being served, and the mutual listing restores blocks of registered subjects", async () => {
        await run("INSERT INTO graph_owners (did) VALUES ('did:o')")
        await run("INSERT INTO interest (did, registered) VALUES ('did:o', 1)")
        await putBlock("did:o", "1", "did:anyone")
        await putBlock("did:o", "2", "did:reg")
        const budget = statementBudget(5)
        await d1FollowEdgeWriter(db, budget).mirror([
            {
                now: row("did:o", { member: true }),
                mirrored: row("did:o", { owner: true, member: true, registered: true }),
            },
        ])
        expect(budget.remaining).toBe(0)
        expect(await blocksOf("did:o")).toEqual([])

        const s = registeredStub("bm")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers("did:o", 1, 1)
            await obj.register("did:reg")
            stubNet(obj, {
                blockLists: {
                    "did:o": [
                        { rkey: "1", subject: "did:anyone" },
                        { rkey: "2", subject: "did:reg" },
                    ],
                },
            })
            expect(await step(obj)).toContain("listed")
        })
        expect((await blocksOf("did:o")).map((r) => r.subject)).toEqual(["did:reg"])
    })

    it("a mirror without a prune leaves a DID's blocks", async () => {
        await run("INSERT INTO interest (did, registered) VALUES ('did:m', 0)")
        await putBlock("did:m", "1", "did:reg")
        await mirror(11, {
            now: row("did:m", { member: true, holder: true }),
            mirrored: row("did:m", { member: true }),
        })
        expect(await blocksOf("did:m")).toHaveLength(1)
        expect(await all("SELECT 1 FROM blocks")).toHaveLength(1)
    })
})
