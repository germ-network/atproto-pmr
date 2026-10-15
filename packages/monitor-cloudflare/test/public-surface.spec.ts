/** The ingest object publishes no follow graph to KV. */
import { runDurableObjectAlarm } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import * as monitorCloudflare from "../src"
import { clearGraph, db, inObj, registeredStub, testEnv } from "./listing-harness"

beforeEach(clearGraph)

describe("monitor-cloudflare public surface", () => {
    it("exports no KV graph projection store", () => {
        expect(monitorCloudflare).not.toHaveProperty("kvGraphProjections")
    })

    it("an alarm over served graphs with follow changes writes no graph:<did> key", async () => {
        const did = "did:plc:served-owner"
        const s = registeredStub("public-surface")
        await testEnv.pmrDirectory.put(did, "1")
        try {
        await inObj(s, async (obj) => {
            await obj.setRegistered(did, true, 1)
            obj.ctx.storage.sql.exec(
                "INSERT OR REPLACE INTO listings (did, listed_at, owner_listed_at) VALUES (?, 1, 1)",
                did
            )
        })
        await db.prepare("INSERT INTO graph_holders (did) VALUES ('did:plc:holder')").run()
        await db
            .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, 'f', 'did:plc:holder', 1)")
            .bind(did)
            .run()
        await inObj(s, (obj) => (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog())
        const original = globalThis.fetch
        globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
        try {
            for (let i = 0; i < 2; i++) {
                await runDurableObjectAlarm(s).catch((err) => {
                    if (!/did not upgrade/.test(String(err))) throw err
                })
            }
        } finally {
            globalThis.fetch = original
        }
        expect(await db.prepare("SELECT did FROM graph_owners WHERE did = ?").bind(did).first()).not.toBeNull()
        expect((await testEnv.records.list({ prefix: "graph:" })).keys).toEqual([])
        } finally {
            await testEnv.pmrDirectory.delete(did)
        }
    })
})
