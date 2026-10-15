/**
 * Admission is read straight from D1 and the records KV, judging the hosted
 * recipient's view of the sender, without touching the monitor's ingest object.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredPolicies, StoredRecordSnapshot } from "@germ-network/atproto-pmr-core"
import { d1AdmissionSource } from "../src/admission-source"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import type { MonitorEnv } from "../src/env"
import { statementBudget } from "../src/follow-edge-store"

const db = (env as unknown as MonitorEnv & { graph: D1Database }).graph
const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
const serve = (did: string) => run("INSERT INTO graph_owners (did) VALUES (?)", did)
const follow = (follower: string, subject: string) =>
    run("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, 1)", follower, `r-${follower}-${subject}`, subject)
const blockEdge = (blocker: string, subject: string) =>
    d1BlockEdgeWriter(db, statementBudget(100)).putBlocks([{ blocker, rkey: `b-${subject}`, subject }], 1)

const SENDER = "did:plc:sender"
const RECIPIENT = "did:plc:recipient"

function source(over: { policies?: StoredPolicies; freshAtMs?: number; serves?: (did: string) => boolean; recheck?: () => void } = {}) {
    const readDeclaration = vi.fn(async () => ({ found: false as const, reason: "no PDS" }))
    const snapshot = async (): Promise<StoredRecordSnapshot> => ({
        car: new Uint8Array([1]),
        freshAtMs: over.freshAtMs ?? Date.now(),
        verifiedWith: "zKey",
        rev: "r",
        cid: "c",
        policies: over.policies ?? { found: true, policies: ["bsky-follows"] },
    })
    const admission = d1AdmissionSource({
        db,
        snapshots: {
            serves: async (did) => (over.serves ? over.serves(did) : did === RECIPIENT),
            snapshot,
            readDeclaration,
            ...(over.recheck ? { recheck: over.recheck } : {}),
        } as never,
    })
    return { admission, readDeclaration }
}

beforeEach(async () => {
    await db.batch(
        ["blocks", "follows", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("d1AdmissionSource", () => {
    it("judges (sender, recipient) with the recipient's policies and the recipient's facts about the sender; swapping them changes the verdict", async () => {
        await serve(RECIPIENT)
        await follow(RECIPIENT, SENDER)
        const { admission } = source()
        expect(await admission.admission(SENDER, RECIPIENT)).toEqual({ verdict: "yes" })
        // Reversed, the "recipient" is the sender: not hosted here, and the
        // follow runs the other way.
        expect(await admission.admission(RECIPIENT, SENDER)).toEqual({
            verdict: "unknown",
            why: ["recipient-not-held"],
        })
        // With both served, the follow runs sender-to-recipient only, so the reversed pair is a no.
        await serve(SENDER)
        const both = source({ serves: () => true })
        expect((await both.admission.admission(RECIPIENT, SENDER)).verdict).toBe("no")
    })

    it("a recipient who blocks the sender reads blocked", async () => {
        await serve(RECIPIENT)
        await blockEdge(RECIPIENT, SENDER)
        expect(await source().admission.admission(SENDER, RECIPIENT)).toEqual({ verdict: "blocked" })
    })

    it("a recipient whose graph is not served reads unknown", async () => {
        const result = await source().admission.admission(SENDER, RECIPIENT)
        expect(result.verdict).toBe("unknown")
    })

    it("an open-only recipient admits nobody yet", async () => {
        await serve(RECIPIENT)
        const { admission } = source({ policies: { found: true, policies: ["open"] } })
        expect(await admission.admission(SENDER, RECIPIENT)).toEqual({
            verdict: "unknown",
            why: ["policy-not-enabled"],
        })
    })

    it("reads no PDS and does not touch the ingest object, even for a stale snapshot", async () => {
        await serve(RECIPIENT)
        await follow(RECIPIENT, SENDER)
        const recheck = vi.fn()
        const stale = Date.now() - 365 * 24 * 60 * 60 * 1000
        const { admission, readDeclaration } = source({ freshAtMs: stale, recheck })
        expect(await admission.admission(SENDER, RECIPIENT)).toEqual({ verdict: "yes" })
        expect(recheck).not.toHaveBeenCalled()
        expect(readDeclaration).not.toHaveBeenCalled()
    })
})
