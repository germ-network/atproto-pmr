/**
 * The read paths' key and index reads cost a few bulk store reads per
 * hundred DIDs or records, and never reach the network or read a CAR.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { DECLARATION_COLLECTION_NSID, type CachedDidDocument } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry } from "@germ-network/atproto-pmr-monitor"
import { DID_DOCUMENT_PREFIX, PLC_COVERAGE_KEY, kvReadSigningKeys } from "../src/did-document-store"
import type { MonitorEnv } from "../src/env"
import { kvSnapshotStore, kvSummaryIndexReader } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv
const NOW = 2_000_000_000_000
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

const cached = (did: string, fetchedAtMs = NOW): CachedDidDocument => ({
    doc: {
        id: did,
        verificationMethod: [
            { id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: KEY },
        ],
    },
    fetchedAtMs,
    source: "plc",
})
const putDoc = (did: string, value: CachedDidDocument | string) =>
    testEnv.records.put(
        DID_DOCUMENT_PREFIX + did,
        typeof value === "string" ? value : JSON.stringify(value)
    )

/** Counts bulk and single `get` calls on `records`, and the keys per bulk call. */
function spied() {
    const bulk: number[] = []
    const single: string[] = []
    const real = testEnv.records
    const records = new Proxy(real, {
        get(target, prop) {
            if (prop === "get") {
                return (keys: string | string[], ...rest: unknown[]) => {
                    if (Array.isArray(keys)) bulk.push(keys.length)
                    else single.push(keys)
                    return (target.get as Function).call(target, keys, ...rest)
                }
            }
            const value = Reflect.get(target, prop) as unknown
            return typeof value === "function" ? value.bind(target) : value
        },
    })
    return { env: { ...testEnv, records } as MonitorEnv, bulk, single }
}

describe("kvReadSigningKeys", () => {
    it("maps every DID asked, reading doc: in bulks of at most 100 and plc:coverage once", async () => {
        const dids = Array.from({ length: 230 }, (_, i) => `did:plc:bulk${i}`)
        await Promise.all(dids.map((d) => putDoc(d, cached(d))))
        // Far older than the document window, so only the coverage run vouches for it.
        await putDoc(dids[1]!, cached(dids[1]!, NOW - 3_600_000))
        await testEnv.records.put(
            PLC_COVERAGE_KEY,
            JSON.stringify({ url: "wss://p", continuousSinceMs: NOW - 7_200_000, coveredThroughMs: NOW })
        )
        const s = spied()
        const keys = await kvReadSigningKeys(s.env, () => NOW).keysFor([...dids, dids[0]!])
        expect(keys.size).toBe(230)
        for (const did of dids) expect(keys.get(did)).toEqual({ kind: "trusted", key: KEY })
        expect(s.bulk).toEqual([100, 100, 30])
        expect(s.single).toEqual([PLC_COVERAGE_KEY])
    })

    it("a malformed or missing doc: entry is unknown for did:plc", async () => {
        await putDoc("did:plc:garbled", "{not json")
        await putDoc("did:plc:shapeless", '{"doc":{},"fetchedAtMs":1,"source":"plc"}')
        const keys = await kvReadSigningKeys(testEnv, () => NOW).keysFor([
            "did:plc:garbled",
            "did:plc:shapeless",
            "did:plc:absent",
        ])
        expect([...keys.values()]).toEqual([
            { kind: "unknown" },
            { kind: "unknown" },
            { kind: "unknown" },
        ])
    })

    it("a did:web DID is unchecked", async () => {
        const s = spied()
        const keys = await kvReadSigningKeys(s.env, () => NOW).keysFor(["did:web:example.com"])
        expect(keys.get("did:web:example.com")).toEqual({ kind: "unchecked" })
        expect(s.bulk).toEqual([])
        expect(s.single).toEqual([])
    })

    it("a missing coverage entry limits trust to the document's ten minutes", async () => {
        await testEnv.records.delete(PLC_COVERAGE_KEY)
        await putDoc("did:plc:fresh-nocov", cached("did:plc:fresh-nocov", NOW - 60_000))
        await putDoc("did:plc:old-nocov", cached("did:plc:old-nocov", NOW - 3_600_000))
        const keys = await kvReadSigningKeys(testEnv, () => NOW).keysFor([
            "did:plc:fresh-nocov",
            "did:plc:old-nocov",
        ])
        expect(keys.get("did:plc:fresh-nocov")).toEqual({ kind: "trusted", key: KEY })
        expect(keys.get("did:plc:old-nocov")).toEqual({ kind: "unknown" })
    })
})

const PROFILE = "app.example.profile"
const entry = (rev: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
    rev,
    car: new Uint8Array([1, 2, 3]),
    observedAtMs: 1_000,
    source: "https://pds.example",
    signingKey: "zKey",
    verifiedWith: "zKey",
    cid: "bafyreicid",
    ...over,
})
const uniq = () => `did:plc:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`

describe("kvSummaryIndexReader", () => {
    it("returns each ref's cid, verifiedWith and freshAtMs from metadata, in ref order", async () => {
        const [a, b] = [uniq(), uniq()]
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(a, entry("3m1", { cid: "cid-a" }))
        await store.putSecondary({ did: b, collection: PROFILE, rkey: "self" }, entry("3m2", { cid: "cid-b", verifiedWith: "zOther" }))
        const refs = [
            { did: b, collection: PROFILE, rkey: "self" },
            { did: a, collection: DECLARATION_COLLECTION_NSID, rkey: "self" },
            { did: uniq(), collection: PROFILE, rkey: "self" },
        ]
        expect(await kvSummaryIndexReader(testEnv).entries(refs)).toEqual([
            { ...refs[0], cid: "cid-b", verifiedWith: "zOther", commitCid: null, rev: "3m2", evidenceState: null, freshAtMs: 1_000 },
            { ...refs[1], cid: "cid-a", verifiedWith: "zKey", commitCid: null, rev: "3m1", evidenceState: null, freshAtMs: 1_000, policies: { found: false, code: "undecodable" } },
            null,
        ])
    })

    it("freshAtMs takes a chk: confirmation only at the same rev", async () => {
        const [a, b] = [uniq(), uniq()]
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(a, entry("3m1"))
        await store.putCheck(a, { rev: "3m1", checkedAtMs: 9_000 })
        await store.putRecord(b, entry("3m1"))
        await store.putCheck(b, { rev: "3m0", checkedAtMs: 9_000 })
        const refs = [a, b].map((did) => ({ did, collection: DECLARATION_COLLECTION_NSID, rkey: "self" }))
        const read = await kvSummaryIndexReader(testEnv).entries(refs)
        expect(read.map((e) => e?.freshAtMs)).toEqual([9_000, 1_000])
    })

    it("an entry with no verified metadata or no cid reads null", async () => {
        const [unverified, noCid] = [uniq(), uniq()]
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(unverified, entry("3m1", { verifiedWith: null }))
        await store.putRecord(noCid, entry("3m1", { cid: null }))
        const refs = [unverified, noCid].map((did) => ({
            did,
            collection: DECLARATION_COLLECTION_NSID,
            rkey: "self",
        }))
        expect(await kvSummaryIndexReader(testEnv).entries(refs)).toEqual([null, null])
    })

    it("reads keys in bulks of at most 100", async () => {
        const refs = Array.from({ length: 230 }, () => ({
            did: uniq(),
            collection: DECLARATION_COLLECTION_NSID,
            rkey: "self",
        }))
        const bulk: number[] = []
        const real = testEnv.records
        const records = new Proxy(real, {
            get(target, prop) {
                const value = Reflect.get(target, prop) as unknown
                if (prop === "get" || prop === "getWithMetadata") {
                    return (keys: string | string[], ...rest: unknown[]) => {
                        if (Array.isArray(keys)) bulk.push(keys.length)
                        return (value as Function).call(target, keys, ...rest)
                    }
                }
                return typeof value === "function" ? value.bind(target) : value
            },
        })
        await kvSummaryIndexReader({ ...testEnv, records } as MonitorEnv).entries(refs)
        expect(bulk.sort()).toEqual([100, 100, 100, 100, 30, 30])
    })
})
