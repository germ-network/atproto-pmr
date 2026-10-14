/** `sk:<did>` in `records`: the shape the relay's cache reads. */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { SIGNING_KEY_MAX_STALE_MS } from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "../src/env"
import { kvSigningKeyCache } from "../src/signing-key-store"

const testEnv = env as unknown as MonitorEnv

describe("kvSigningKeyCache", () => {
    it("put then get round-trips {key, fetchedAtMs}, including key: null", async () => {
        const cache = kvSigningKeyCache(testEnv)
        await cache.put("did:plc:rt", { key: "zK", fetchedAtMs: 12 })
        expect(await cache.get("did:plc:rt")).toEqual({ key: "zK", fetchedAtMs: 12 })
        await cache.put("did:plc:rtnull", { key: null, fetchedAtMs: 13 })
        expect(await cache.get("did:plc:rtnull")).toEqual({ key: null, fetchedAtMs: 13 })
    })

    it("stores under sk:<did> with an expirationTtl no shorter than the relay's max-stale bound", async () => {
        const puts: Array<{ key: string; options?: KVNamespacePutOptions }> = []
        const spy = {
            ...testEnv,
            records: {
                put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
                    puts.push({ key, options })
                    await testEnv.records.put(key, value, options)
                },
            },
        } as unknown as MonitorEnv
        await kvSigningKeyCache(spy).put("did:plc:ttl", { key: "zK", fetchedAtMs: 1 })
        expect(puts).toHaveLength(1)
        expect(puts[0]?.key).toBe("sk:did:plc:ttl")
        expect(puts[0]?.options?.expirationTtl).toBeGreaterThanOrEqual(
            SIGNING_KEY_MAX_STALE_MS / 1000
        )
        expect(await testEnv.records.get("sk:did:plc:ttl", "json")).toEqual({
            key: "zK",
            fetchedAtMs: 1,
        })
    })

    it("delete removes the entry; get → null", async () => {
        const cache = kvSigningKeyCache(testEnv)
        await cache.put("did:plc:del", { key: "zK", fetchedAtMs: 1 })
        await cache.delete("did:plc:del")
        expect(await cache.get("did:plc:del")).toBeNull()
        await expect(cache.delete("did:plc:never")).resolves.toBeUndefined()
    })

    it("get → null for a missing or unparseable value", async () => {
        const cache = kvSigningKeyCache(testEnv)
        expect(await cache.get("did:plc:absent")).toBeNull()
        for (const bad of ["not json", "null", "{}", '{"key":5,"fetchedAtMs":1}', '{"key":"zK"}']) {
            await testEnv.records.put("sk:did:plc:bad", bad)
            expect(await cache.get("did:plc:bad"), bad).toBeNull()
        }
    })
})
