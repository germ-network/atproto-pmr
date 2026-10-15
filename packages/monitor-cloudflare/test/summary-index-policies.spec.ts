/** The summary index reader passes a declaration snapshot's stored policies through. */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry } from "@germ-network/atproto-pmr-monitor"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import type { MonitorEnv } from "../src/env"
import { kvSnapshotStore, kvSummaryIndexReader } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv
const uniq = () => `did:plc:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
const ref = (did: string) => ({ did, collection: DECLARATION_COLLECTION_NSID, rkey: "self" })

/** A keyPackage with no succession proofs and the given policy byte. */
function keyPackage(policy: number): Uint8Array {
    const pkg = [0, policy, 1, 1]
    return Uint8Array.from([0, ...new Array(64).fill(5), pkg.length, ...pkg])
}

const entry = (car: Uint8Array): SnapshotEntry => ({
    rev: "3kaaaaaaaaaaa",
    car,
    observedAtMs: 1_000,
    source: "https://pds.example",
    signingKey: "zKey",
    verifiedWith: "zKey",
    cid: "bafyreicid",
})

describe("kvSummaryIndexReader policies", () => {
    it("returns the stored policies on a declaration entry", async () => {
        const did = uniq()
        const car = buildRepoCar({
            did,
            key: makeKey(),
            records: { [`${DECLARATION_COLLECTION_NSID}/self`]: { keyPackage: keyPackage(2) } },
        }).car
        await kvSnapshotStore(testEnv).putRecord(did, entry(car))
        const [read] = await kvSummaryIndexReader(testEnv).entries([ref(did)])
        expect(read!.policies).toEqual({ found: true, policies: ["open"] })
    })

    it("returns no policies on an entry stored before policies were kept", async () => {
        const did = uniq()
        await testEnv.records.put(`rec:${did}`, new Uint8Array([1]), {
            metadata: { rev: "3k", observedAtMs: 1_000, source: "s", signingKey: "zKey", verifiedWith: "zKey", cid: "c", seenKey: null },
        })
        const [read] = await kvSummaryIndexReader(testEnv).entries([ref(did)])
        expect(read).not.toBeNull()
        expect(read).not.toHaveProperty("policies")
    })

    it("returns no policies on a non-declaration entry", async () => {
        const did = uniq()
        const other = { did, collection: "app.example.profile", rkey: "self" }
        await kvSnapshotStore(testEnv).putSecondary(other, entry(new Uint8Array([1])))
        const [read] = await kvSummaryIndexReader(testEnv).entries([other])
        expect(read).not.toBeNull()
        expect(read).not.toHaveProperty("policies")
    })
})
