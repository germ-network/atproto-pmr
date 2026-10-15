/** A relay reads its contacts' block and follow facts from D1 directly, through a session a replica may serve. */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import type { MonitorEnv } from "../src/env"
import { statementBudget } from "../src/follow-edge-store"
import { d1SenderGraphReader } from "../src/sender-graph-reader"

const db = (env as unknown as MonitorEnv & { graph: D1Database }).graph
const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()

const SENDER = "did:plc:sender"
const RECIPIENTS = ["did:blocker", "did:follower", "did:served", "did:stranger"]

beforeEach(async () => {
    await db.batch(
        ["blocks", "follows", "graph_owners", "graph_holders", "interest"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
    await run("INSERT INTO graph_owners (did) VALUES (?)", "did:blocker")
    await run("INSERT INTO graph_owners (did) VALUES (?)", "did:follower")
    await run("INSERT INTO graph_owners (did) VALUES (?)", "did:served")
    await run("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, 1)", "did:follower", "r1", SENDER)
    await d1BlockEdgeWriter(db, statementBudget(100)).putBlocks(
        [{ blocker: "did:blocker", rkey: "b1", subject: SENDER }],
        1
    )
})

describe("d1SenderGraphReader over a D1 session", () => {
    it("answers the same facts through db.withSession() as through the database", async () => {
        const direct = await d1SenderGraphReader(db).forSender(SENDER, RECIPIENTS)
        const session = await d1SenderGraphReader(db.withSession()).forSender(SENDER, RECIPIENTS)
        expect(direct.get("did:blocker")).toEqual({ blocks: "yes", follows: "no" })
        expect(direct.get("did:follower")).toEqual({ blocks: "no", follows: "yes" })
        expect(direct.get("did:served")).toEqual({ blocks: "no", follows: "no" })
        expect(direct.get("did:stranger")).toEqual({ blocks: "unknown", follows: "unknown" })
        expect(session).toEqual(direct)
    })

    it("rejects when D1 cannot answer for a non-empty recipient list, rather than answering unknown", async () => {
        const failing = {
            prepare: () => {
                throw new Error("d1 down")
            },
            batch: () => Promise.reject(new Error("d1 down")),
        }
        await expect(d1SenderGraphReader(failing).forSender(SENDER, ["did:served"])).rejects.toThrow("d1 down")
    })
})
