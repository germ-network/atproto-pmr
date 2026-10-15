/** The block index in D1: writes, and the two reads that never list another DID's blocks. */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { D1_ROWS_PER_STATEMENT } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { d1BlockEdgeStore, d1BlockEdgeWriter } from "../src/block-edge-store"
import { statementBudget } from "../src/follow-edge-store"

const db = (env as unknown as MonitorEnv & { graph: D1Database }).graph

const writer = (limit = 1000) => d1BlockEdgeWriter(db, statementBudget(limit))
const store = d1BlockEdgeStore(db)
const block = (blocker: string, rkey: string, subject: string) => ({ blocker, rkey, subject })

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return (await db.prepare(sql).bind(...binds).all<T>()).results
}
const rows = () =>
    all<{ blocker: string; rkey: string; subject: string; gen: number }>(
        "SELECT blocker, rkey, subject, gen FROM blocks ORDER BY blocker, rkey"
    )
const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
const serve = (did: string) => run("INSERT INTO graph_owners (did) VALUES (?)", did)
const interest = (did: string, registered: number) =>
    run("INSERT INTO interest (did, registered) VALUES (?, ?)", did, registered)

beforeEach(async () => {
    await db.batch(
        ["blocks", "follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("d1BlockEdgeWriter", () => {
    it("putBlocks is idempotent on (blocker, rkey) and replaces the subject and generation", async () => {
        await writer().putBlocks([block("did:a", "1", "did:x"), block("did:a", "2", "did:y")], 1)
        await writer().putBlocks([block("did:a", "1", "did:z")], 2)
        await writer().putBlocks([block("did:a", "1", "did:z")], 2)
        expect(await rows()).toEqual([
            { blocker: "did:a", rkey: "1", subject: "did:z", gen: 2 },
            { blocker: "did:a", rkey: "2", subject: "did:y", gen: 1 },
        ])
    })

    it("putBlocks chunks past one statement's row limit and charges each statement to the budget", async () => {
        const many = Array.from({ length: D1_ROWS_PER_STATEMENT * 2 + 1 }, (_, i) =>
            block("did:a", `r${String(i).padStart(3, "0")}`, `did:s${i}`)
        )
        const budget = statementBudget(10)
        await d1BlockEdgeWriter(db, budget).putBlocks(many, 1)
        expect(await rows()).toHaveLength(many.length)
        expect(budget.remaining).toBe(7)
        await expect(writer(2).putBlocks(many, 2)).rejects.toThrow(/budget/)
        expect((await rows()).every((r) => r.gen === 1)).toBe(true)
    })

    it("deleteBlocks removes by (blocker, rkey) and ignores absent blocks", async () => {
        await writer().putBlocks(
            [block("did:a", "1", "did:x"), block("did:a", "2", "did:y"), block("did:b", "1", "did:x")],
            1
        )
        await writer().deleteBlocks([
            { blocker: "did:a", rkey: "1" },
            { blocker: "did:b", rkey: "9" },
            { blocker: "did:c", rkey: "1" },
        ])
        expect((await rows()).map((r) => [r.blocker, r.rkey])).toEqual([
            ["did:a", "2"],
            ["did:b", "1"],
        ])
        await writer().deleteBlocks([])
    })

    it("sweepBlocks deletes only the blocker's rows older than the generation", async () => {
        await writer().putBlocks([block("did:a", "old", "did:x"), block("did:b", "old", "did:x")], 1)
        await writer().putBlocks([block("did:a", "new", "did:y")], 2)
        await writer().sweepBlocks("did:a", 2)
        expect((await rows()).map((r) => [r.blocker, r.rkey])).toEqual([
            ["did:a", "new"],
            ["did:b", "old"],
        ])
    })

    it("writes no graph_changes rows", async () => {
        await serve("did:a")
        await writer().putBlocks([block("did:a", "1", "did:x")], 1)
        await writer().putBlocks([block("did:a", "1", "did:y")], 2)
        await writer().sweepBlocks("did:a", 3)
        await writer().putBlocks([block("did:a", "1", "did:y")], 3)
        await writer().deleteBlocks([{ blocker: "did:a", rkey: "1" }])
        expect(await all("SELECT * FROM graph_changes")).toEqual([])
    })
})

describe("d1BlockEdgeStore", () => {
    it("ownBlocks returns a served owner's blocks ordered by rkey", async () => {
        await serve("did:a")
        await writer().putBlocks(
            [block("did:a", "b", "did:y"), block("did:a", "a", "did:x"), block("did:other", "0", "did:z")],
            1
        )
        expect(await store.ownBlocks("did:a")).toEqual([
            block("did:a", "a", "did:x"),
            block("did:a", "b", "did:y"),
        ])
    })

    it("ownBlocks returns null for a DID whose graph is not served", async () => {
        await writer().putBlocks([block("did:a", "1", "did:x")], 1)
        await interest("did:a", 0)
        expect(await store.ownBlocks("did:a")).toBeNull()
    })

    it("ownBlocks returns [] for a served owner with no blocks", async () => {
        await serve("did:a")
        expect(await store.ownBlocks("did:a")).toEqual([])
    })

    it("isBlocked is true only for a kept block naming that subject", async () => {
        await serve("did:owner")
        await interest("did:reg", 1)
        await writer().putBlocks(
            [
                block("did:owner", "1", "did:x"),
                block("did:member", "1", "did:reg"),
                block("did:member", "2", "did:unreg"),
            ],
            1
        )
        expect(await store.isBlocked("did:owner", "did:x")).toBe(true)
        expect(await store.isBlocked("did:owner", "did:y")).toBe(false)
        expect(await store.isBlocked("did:x", "did:owner")).toBe(false)
        expect(await store.isBlocked("did:member", "did:reg")).toBe(true)
        expect(await store.isBlocked("did:member", "did:unreg")).toBe(false)
    })

    it("isBlocked ignores a non-owner's block once its subject is no longer registered", async () => {
        await interest("did:reg", 1)
        await writer().putBlocks([block("did:member", "1", "did:reg")], 1)
        expect(await store.isBlocked("did:member", "did:reg")).toBe(true)
        await run("UPDATE interest SET registered = 0 WHERE did = ?", "did:reg")
        expect(await store.isBlocked("did:member", "did:reg")).toBe(false)
        await run("DELETE FROM interest WHERE did = ?", "did:reg")
        expect(await store.isBlocked("did:member", "did:reg")).toBe(false)
    })
})

describe("d1BlockEdgeStore.blockersOf", () => {
    it("b is in blockersOf(s, [b]) exactly when isBlocked(b, s), across owner, non-owner, stale and registered-subject fixtures", async () => {
        await serve("did:owner")
        await interest("did:reg", 1)
        await interest("did:stale", 0)
        await writer().putBlocks(
            [
                block("did:owner", "1", "did:x"),
                block("did:owner", "2", "did:reg"),
                block("did:member", "1", "did:reg"),
                block("did:member", "2", "did:x"),
                block("did:member", "3", "did:stale"),
            ],
            1
        )
        const blockers = ["did:owner", "did:member", "did:nobody"]
        for (const subject of ["did:x", "did:reg", "did:stale", "did:none"]) {
            for (const b of blockers) {
                const set = await store.blockersOf(subject, [b])
                expect(set.has(b), `${b} -> ${subject}`).toBe(await store.isBlocked(b, subject))
            }
        }
        expect(await store.blockersOf("did:x", blockers)).toEqual(new Set(["did:owner"]))
        expect(await store.blockersOf("did:reg", blockers)).toEqual(new Set(["did:owner", "did:member"]))
    })

    it("answers many blockers of one subject in one statement", async () => {
        await serve("did:o1")
        await serve("did:o2")
        await writer().putBlocks([block("did:o1", "1", "did:x"), block("did:o2", "1", "did:x")], 1)
        const prepare = vi.spyOn(db, "prepare")
        try {
            const set = await store.blockersOf("did:x", ["did:o1", "did:o2", "did:o3"])
            expect(set).toEqual(new Set(["did:o1", "did:o2"]))
            expect(prepare).toHaveBeenCalledTimes(1)
        } finally {
            prepare.mockRestore()
        }
    })

    it("an empty blockers list reads nothing and returns an empty set", async () => {
        const prepare = vi.spyOn(db, "prepare")
        try {
            expect(await store.blockersOf("did:x", [])).toEqual(new Set())
            expect(prepare).not.toHaveBeenCalled()
        } finally {
            prepare.mockRestore()
        }
    })
})
