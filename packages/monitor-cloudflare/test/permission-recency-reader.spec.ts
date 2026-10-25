import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MonitorEnv } from "../src/env"
import { d1PermissionRecencyReader } from "../src/permission-recency-reader"
import { snapshotKeys } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv & { graph: D1Database }
const db = testEnv.graph
const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run()
const S = "did:plc:recency-sender"
const R = "did:plc:recency-recipient"
const at = 1_700_000_000_000
function tid(ms: number) {
    let value = BigInt(ms) * 1000n << 10n
    let out = ""
    for (let i = 0; i < 13; i++) {
        out = "234567abcdefghijklmnopqrstuvwxyz"[Number(value & 31n)] + out
        value >>= 5n
    }
    return out
}
const follow = (follower: string, subject: string, rkey: string) => run(
    "INSERT INTO follows (follower, subject, rkey, gen) VALUES (?, ?, ?, 1)", follower, subject, rkey)

beforeEach(async () => {
    await db.batch(["follows", "graph_owners", "graph_holders"].map((t) => db.prepare(`DELETE FROM ${t}`)))
    for (const did of [S, R]) await run("INSERT INTO graph_holders (did) VALUES (?)", did)
    await run("INSERT INTO graph_owners (did) VALUES (?)", R)
    await testEnv.records.put(snapshotKeys(R, "com.germnetwork.declaration", "self").record, "car", {
        metadata: { messagingKeyFirstSeenAtMs: at },
    })
    await follow(S, R, tid(at + 100))
    await follow(R, S, tid(at + 200))
})

describe("d1PermissionRecencyReader", () => {
    it("reads reciprocal facts for a non-owner sender holder on a request session", async () => {
        expect(await db.prepare("SELECT did FROM graph_owners WHERE did = ?").bind(S).first()).toBeNull()
        const read = d1PermissionRecencyReader(db.withSession("first-unconstrained"), testEnv)
        expect(await read(S, [R])).toEqual(new Map([[R, at + 200]]))
    })

    it("uses the newest active duplicate and makes any malformed duplicate unknown", async () => {
        const read = d1PermissionRecencyReader(db, testEnv)
        await follow(S, R, tid(at + 300))
        expect((await read(S, [R])).get(R)).toBe(at + 300)
        await follow(S, R, "malformed")
        expect((await read(S, [R])).get(R)).toBeNull()
    })

    it("returns unknown without both reciprocal facts or a key first-seen time", async () => {
        const read = d1PermissionRecencyReader(db, testEnv)
        await run("DELETE FROM follows WHERE follower = ?", S)
        expect((await read(S, [R])).get(R)).toBeNull()
        await follow(S, R, tid(at + 100))
        await testEnv.records.delete(snapshotKeys(R, "com.germnetwork.declaration", "self").record)
        expect((await read(S, [R])).get(R)).toBeNull()
    })

    it("filters stale rows outside held and served graphs", async () => {
        const read = d1PermissionRecencyReader(db, testEnv)
        await run("DELETE FROM graph_owners")
        expect((await read(S, [R])).get(R)).toBeNull()
        await run("INSERT INTO graph_owners (did) VALUES (?)", R)
        await run("DELETE FROM graph_holders WHERE did = ?", S)
        expect((await read(S, [R])).get(R)).toBeNull()
    })

    it("batches directional queries and KV metadata rather than querying per recipient", async () => {
        const session = db.withSession("first-unconstrained")
        const batch = vi.fn(session.batch.bind(session))
        const metadata = vi.spyOn(testEnv.records, "getWithMetadata")
        const read = d1PermissionRecencyReader({ prepare: session.prepare.bind(session), batch }, testEnv)
        const recipients = [R, ...Array.from({ length: 50 }, (_, i) => `did:plc:unknown${i}`)]
        const result = await read(S, [...recipients, R])
        expect(result.size).toBe(51)
        expect(result.get(R)).toBe(at + 200)
        expect(batch).toHaveBeenCalledOnce()
        expect(batch.mock.calls[0]![0]).toHaveLength(4)
        expect(metadata).toHaveBeenCalledOnce()
        expect(metadata.mock.calls[0]![0]).toHaveLength(51)
        metadata.mockRestore()
    })

    it("keeps optional ranking unavailable on storage failures and skips empty reads", async () => {
        const batch = vi.fn(async () => { throw new Error("D1 unavailable") })
        const read = d1PermissionRecencyReader({ prepare: db.prepare.bind(db), batch }, testEnv)
        expect(await read(S, [])).toEqual(new Map())
        expect(batch).not.toHaveBeenCalled()
        expect(await read(S, [R])).toEqual(new Map([[R, null]]))
    })
})
