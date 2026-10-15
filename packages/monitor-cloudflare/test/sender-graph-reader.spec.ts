/**
 * Batched graph facts answer no only for a served recipient, whose edges
 * are complete, and unknown for everyone else, in a bounded number of
 * queries.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import type { MonitorEnv } from "../src/env"
import { statementBudget } from "../src/follow-edge-store"
import { d1SenderGraphReader } from "../src/sender-graph-reader"

const db = (env as unknown as MonitorEnv & { graph: D1Database }).graph
const reader = d1SenderGraphReader(db)
const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
const serve = (did: string) => run("INSERT INTO graph_owners (did) VALUES (?)", did)
const interest = (did: string, registered: number) =>
    run("INSERT INTO interest (did, registered) VALUES (?, ?)", did, registered)
const follow = (follower: string, subject: string) =>
    run("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, 1)", follower, `r-${follower}-${subject}`, subject)
const blockEdge = (blocker: string, subject: string) =>
    d1BlockEdgeWriter(db, statementBudget(100)).putBlocks([{ blocker, rkey: `b-${subject}`, subject }], 1)

const SENDER = "did:plc:sender"
const facts = async (...recipients: string[]) => (await reader.forSender(SENDER, recipients))

beforeEach(async () => {
    await db.batch(
        ["blocks", "follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("d1SenderGraphReader follows", () => {
    it("a kept follow from recipient to sender is yes, whoever holds it", async () => {
        await follow("did:served", SENDER)
        await follow("did:member", SENDER)
        await serve("did:served")
        await interest("did:member", 0)
        const got = await facts("did:served", "did:member")
        expect(got.get("did:served")!.follows).toBe("yes")
        expect(got.get("did:member")!.follows).toBe("yes")
    })

    it("a follow in the other direction does not count", async () => {
        await follow(SENDER, "did:served")
        await serve("did:served")
        expect((await facts("did:served")).get("did:served")!.follows).toBe("no")
    })

    it("no row, recipient's graph served: no", async () => {
        await serve("did:served")
        expect((await facts("did:served")).get("did:served")).toEqual({ blocks: "no", follows: "no" })
    })

    it("no row, recipient in interest but not served, even with a registered sender: unknown", async () => {
        await interest("did:member", 1)
        await interest(SENDER, 1)
        expect((await facts("did:member")).get("did:member")!.follows).toBe("unknown")
    })

    it("no row, recipient not in interest: unknown", async () => {
        expect((await facts("did:stranger")).get("did:stranger")!.follows).toBe("unknown")
    })
})

describe("d1SenderGraphReader blocks", () => {
    it("yes exactly when BlockEdgeStore.blockersOf(sender, [recipient]) names the recipient", async () => {
        await serve("did:blocker")
        await serve("did:other")
        await blockEdge("did:blocker", SENDER)
        await blockEdge("did:ghost", SENDER)
        const got = await facts("did:blocker", "did:other", "did:ghost")
        expect(got.get("did:blocker")!.blocks).toBe("yes")
        expect(got.get("did:other")!.blocks).toBe("no")
        expect(got.get("did:ghost")!.blocks).toBe("unknown")
    })

    it("no block, recipient's graph served: no", async () => {
        await serve("did:served")
        expect((await facts("did:served")).get("did:served")!.blocks).toBe("no")
    })

    it("no block, recipient not served (in interest or not): unknown", async () => {
        await interest("did:member", 1)
        const got = await facts("did:member", "did:stranger")
        expect(got.get("did:member")!.blocks).toBe("unknown")
        expect(got.get("did:stranger")!.blocks).toBe("unknown")
    })
})

describe("d1SenderGraphReader batching", () => {
    it("one entry per distinct recipient, duplicates collapsed", async () => {
        const got = await reader.forSender(SENDER, ["did:a", "did:b", "did:a"])
        expect([...got.keys()]).toEqual(["did:a", "did:b"])
    })

    it("the statement count does not grow with the number of recipients beyond D1 bind-limit chunking", async () => {
        const count = async (n: number) => {
            const prepare = vi.spyOn(db, "prepare")
            try {
                const dids = Array.from({ length: n }, (_, i) => `did:r${i}`)
                const got = await reader.forSender(SENDER, dids)
                expect(got.size).toBe(n)
                return prepare.mock.calls.length
            } finally {
                prepare.mockRestore()
            }
        }
        const one = await count(1)
        expect(await count(50)).toBe(one)
        expect(await count(120)).toBe(one * 3)
    })

    it("an empty recipient list reads nothing and returns an empty map", async () => {
        const prepare = vi.spyOn(db, "prepare")
        try {
            expect((await reader.forSender(SENDER, [])).size).toBe(0)
            expect(prepare).not.toHaveBeenCalled()
        } finally {
            prepare.mockRestore()
        }
    })
})
