/**
 * The read paths' key and index reads cost a few bulk store reads per
 * hundred DIDs or records, and never reach the network or read a CAR.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { CachedDidDocument } from "@germ-network/atproto-pmr-core"
import { DID_DOCUMENT_PREFIX, PLC_COVERAGE_KEY, kvReadSigningKeys } from "../src/did-document-store"
import type { MonitorEnv } from "../src/env"

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

describe("kvSummaryIndexReader", () => {
    it.todo("returns each ref's cid, verifiedWith and freshAtMs from metadata, in ref order")
    it.todo("freshAtMs takes a chk: confirmation only at the same rev")
    it.todo("an entry with no verified metadata or no cid reads null")
    it.todo("reads keys in bulks of at most 100")
})
