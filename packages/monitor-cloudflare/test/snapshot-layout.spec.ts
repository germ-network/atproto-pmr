/**
 * Every snapshot is a v2 entry: bounded index metadata, plus a value envelope
 * of public detail and the CAR, in one put. Readers serve only v2.
 */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry, SnapshotEvidence } from "@germ-network/atproto-pmr-monitor"
import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import type { MonitorEnv } from "../src/env"
import { normalizeMonitorHostname } from "../src/ingest-object"
import {
    decodeSnapshotValue,
    encodeSnapshotValue,
    KV_METADATA_MAX_BYTES,
    SnapshotMetadataTooLarge,
    snapshotIndexMetaBytes,
    type SnapshotIndexMeta,
} from "../src/snapshot-layout"
import {
    kvDeclarationSnapshots,
    kvDeclaredKeyPage,
    kvMessagingKeyFirstSeenMany,
    kvRecordSnapshots,
    kvSnapshotStore,
    kvSummaryIndexReader,
} from "../src/snapshot-store"
import { putV2Entry } from "./secondary-read"

const testEnv = env as unknown as MonitorEnv

const uniq = () => crypto.randomUUID().replaceAll("-", "")
const longWebDid = () =>
    `did:web:${uniq()}.users.long-subdomain-of-a-hosting-provider.example.com`
const cid = (c: string) => `bafyrei${c.repeat(52)}`
const multibaseKey = (c: string) => `zQ3sh${c.repeat(44)}`
const PDS = "https://hebeloma-chanterelle-morel.us-west.host.bsky.network"
const MAX_HOST = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`

function followsKeyPackage(): Uint8Array {
    const pkg = [0, 1, 1, 1]
    return Uint8Array.from([0, ...new Array(64).fill(5), pkg.length, ...pkg])
}

function declarationCar(did: string): Uint8Array {
    return buildRepoCar({
        did,
        key: makeKey(),
        records: { [`${DECLARATION_COLLECTION_NSID}/self`]: { keyPackage: followsKeyPackage() } },
    }).car
}

const ref = (did: string) => ({ did, collection: DECLARATION_COLLECTION_NSID, rkey: "self" })
const plcAuthority: SnapshotEvidence["authority"] = { method: "plc", operationCid: cid("c") }
const webAuthority = (did: string, relative = false): SnapshotEvidence["authority"] => ({
    method: "web",
    documentUrl: `https://${did.slice("did:web:".length)}/.well-known/did.json`,
    verificationMethodId: relative ? "#atproto" : `${did}#atproto`,
    keyFingerprint: `sha256:${"e".repeat(64)}`,
})

function worstCase(
    did: string,
    authority: SnapshotEvidence["authority"] = plcAuthority,
    monitor = MAX_HOST
): { entry: SnapshotEntry; evidence: SnapshotEvidence } {
    const rev = "3myt4pclukz2d"
    const evidence: SnapshotEvidence = {
        did,
        collection: DECLARATION_COLLECTION_NSID,
        rkey: "self",
        recordCid: cid("a"),
        commitCid: cid("b"),
        rev,
        verifiedWith: multibaseKey("k"),
        authority,
        assurance: "current-key-cross-check",
        monitor,
        commitFirstObservedAtMs: 1_793_000_000_000,
        anchorFirstObservedAtMs: 1_793_000_000_000,
    }
    return {
        evidence,
        entry: {
            rev,
            commitCid: evidence.commitCid,
            car: declarationCar(did),
            observedAtMs: 1_793_000_000_000,
            source: PDS,
            signingKey: multibaseKey("k"),
            verifiedWith: multibaseKey("k"),
            cid: evidence.recordCid,
            evidence,
            messagingKeyFirstSeenAtMs: 1_793_000_000_000,
        },
    }
}

const metaOf = async (key: string) => (await testEnv.records.getWithMetadata(key)).metadata as SnapshotIndexMeta

afterEach(() => vi.restoreAllMocks())

describe("snapshot entry layout", () => {
    it("the index metadata at maximal field lengths (253-char monitor host, did:web) fits the KV cap", async () => {
        for (const authority of [plcAuthority, undefined]) {
            const did = longWebDid()
            const { entry } = worstCase(did, authority === undefined ? webAuthority(did) : authority)
            await kvSnapshotStore(testEnv).putRecord(did, entry)
            const meta = await metaOf(`rec:${did}`)
            expect(snapshotIndexMetaBytes(meta)).toBeLessThanOrEqual(KV_METADATA_MAX_BYTES)
            expect(meta.v).toBe(2)
            expect(meta.policies).toEqual({ found: true, policies: ["bsky-follows"] })
        }
        expect(MAX_HOST).toHaveLength(253)
    })

    it("a monitor hostname over 253 characters is rejected, so evidence never carries one", () => {
        expect(normalizeMonitorHostname(MAX_HOST)).toBe(MAX_HOST)
        expect(normalizeMonitorHostname(`${MAX_HOST}e`)).toBeNull()
        expect(normalizeMonitorHostname(`${MAX_HOST}.`)).toBe(MAX_HOST)
        expect(normalizeMonitorHostname("monitor.example.org")).toBe("monitor.example.org")
    })

    it("a bulk summary read logs non-v2 entries once per call with a count", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const dids = [uniq(), uniq(), uniq()].map((u) => `did:plc:${u.slice(0, 24)}`)
        await testEnv.records.put(`rec:${dids[0]}`, new Uint8Array([1]), {
            metadata: { rev: "3k", observedAtMs: 1, verifiedWith: "zKey", cid: "c" },
        })
        await testEnv.records.put(`rec:${dids[1]}`, new Uint8Array([1]), {
            metadata: { rev: "3k", observedAtMs: 1, verifiedWith: "zKey", cid: "c" },
        })
        await putV2Entry(testEnv, `rec:${dids[2]}`, { verifiedWith: "zKey", cid: "c" })
        const out = await kvSummaryIndexReader(testEnv).entries(dids.map(ref))
        expect(out.map((e) => e !== null)).toEqual([false, false, true])
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith("monitor: snapshot entries not v2", { count: 2 })
    })

    it("writeEntry throws SnapshotMetadataTooLarge rather than trim when metadata exceeds the cap", async () => {
        const did = longWebDid()
        const { entry } = worstCase(did)
        const store = kvSnapshotStore(testEnv)
        await expect(store.putRecord(did, { ...entry, cid: "c".repeat(900) })).rejects.toBeInstanceOf(
            SnapshotMetadataTooLarge
        )
        expect(await testEnv.records.get(`rec:${did}`)).toBeNull()
    })

    it("a value envelope round-trips detail and CAR bytes", () => {
        const car = Uint8Array.from({ length: 300 }, (_, i) => i % 256)
        const detail = { source: `https://${"é".repeat(2000)}.example`, signingKey: "zKey" }
        expect(decodeSnapshotValue(encodeSnapshotValue(detail, car))).toEqual({ detail, car })
        expect(decodeSnapshotValue(encodeSnapshotValue({ source: "s", signingKey: null }, new Uint8Array())))
            .toEqual({ detail: { source: "s", signingKey: null }, car: new Uint8Array() })
    })

    it("decodeSnapshotValue answers null for a truncated or malformed envelope", () => {
        const good = encodeSnapshotValue({ source: "s", signingKey: null }, new Uint8Array([1, 2]))
        expect(decodeSnapshotValue(new Uint8Array([0, 0]))).toBeNull()
        expect(decodeSnapshotValue(good.slice(0, 8))).toBeNull()
        expect(decodeSnapshotValue(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]))).toBeNull()
        const notJson = new Uint8Array([0, 0, 0, 3, 120, 120, 120])
        expect(decodeSnapshotValue(notJson)).toBeNull()
        const overrun = new TextEncoder().encode('{"source":"s","signingKey":null}')
        expect(decodeSnapshotValue(Uint8Array.from([0, 0, 0, overrun.length + 5, ...overrun]))).toBeNull()
        const wrongShape = new TextEncoder().encode('{"source":1}')
        expect(decodeSnapshotValue(Uint8Array.from([0, 0, 0, wrongShape.length, ...wrongShape]))).toBeNull()
    })

    it("a worst-case did:plc declaration round-trips its full evidence", async () => {
        const did = `did:plc:${uniq().slice(0, 24)}`
        const { entry, evidence } = worstCase(did)
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, entry)
        expect((await store.getRecord(did))!.evidence).toEqual(evidence)
        expect((await kvRecordSnapshots(testEnv).get(did, DECLARATION_COLLECTION_NSID, "self"))!.evidence).toEqual(evidence)
        const [summary] = await kvSummaryIndexReader(testEnv).entries([ref(did)])
        expect(summary!.evidenceState).toEqual(evidence)
        expect(summary!.messagingKeyFirstSeenAtMs).toBe(entry.messagingKeyFirstSeenAtMs)
    })

    it("a worst-case did:web declaration round-trips its full evidence with the document URL derived", async () => {
        const did = longWebDid()
        const { entry, evidence } = worstCase(did, webAuthority(did))
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, entry)
        expect((await store.getRecord(did))!.evidence).toEqual(evidence)
        const meta = await metaOf(`rec:${did}`)
        expect(JSON.stringify(meta)).not.toContain("well-known")
        expect(JSON.stringify(meta)).not.toContain("long-subdomain")
    })

    it("a did:web authority with a bare #atproto method id round-trips", async () => {
        const did = longWebDid()
        const { entry, evidence } = worstCase(did, webAuthority(did, true))
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, entry)
        expect((await store.getRecord(did))!.evidence).toEqual(evidence)
    })

    it("getRecord serves source and signingKey from the envelope", async () => {
        const did = `did:plc:${uniq().slice(0, 24)}`
        const { entry } = worstCase(did)
        const longSource = `https://${"p".repeat(2000)}.example`
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, { ...entry, source: longSource })
        expect(await store.getRecord(did)).toMatchObject({
            source: longSource,
            signingKey: entry.signingKey,
            rev: entry.rev,
            cid: entry.cid,
        })
        expect(JSON.stringify(await metaOf(`rec:${did}`))).not.toContain("ppppp")
    })

    it("the record, summary, declaration and first-seen readers treat a v0.3.0-shape entry as not held and log it", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const did = `did:plc:${uniq().slice(0, 24)}`
        await testEnv.records.put(`rec:${did}`, declarationCar(did), {
            metadata: {
                rev: "3k",
                observedAtMs: 1,
                source: "s",
                signingKey: "zKey",
                verifiedWith: "zKey",
                cid: "c",
                seenKey: null,
                commitCid: null,
                evidence: null,
                messagingKeyFirstSeenAtMs: 5,
            },
        })
        expect(await kvRecordSnapshots(testEnv).get(did, DECLARATION_COLLECTION_NSID, "self")).toBeNull()
        expect(await kvSnapshotStore(testEnv).getRecord(did)).toBeNull()
        expect(await kvDeclarationSnapshots(testEnv)(did)).toBeNull()
        expect(await kvSummaryIndexReader(testEnv).entries([ref(did)])).toEqual([null])
        expect((await kvMessagingKeyFirstSeenMany(testEnv, [did])).get(did)).toBeNull()
        expect(warn).toHaveBeenCalledWith("monitor: snapshot entry not v2", { key: `rec:${did}` })
        expect(warn).toHaveBeenCalledWith("monitor: snapshot entries not v2", { count: 1 })
    })

    it("readers treat an entry with an unknown version as not held", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const did = `did:plc:${uniq().slice(0, 24)}`
        await testEnv.records.put(
            `rec:${did}`,
            encodeSnapshotValue({ source: "s", signingKey: null }, declarationCar(did)),
            { metadata: { v: 3, rev: "3k", cid: "c", commitCid: null, verifiedWith: "zKey", observedAtMs: 1 } }
        )
        expect(await kvRecordSnapshots(testEnv).get(did, DECLARATION_COLLECTION_NSID, "self")).toBeNull()
        expect(await kvDeclarationSnapshots(testEnv)(did)).toBeNull()
        expect(await kvSummaryIndexReader(testEnv).entries([ref(did)])).toEqual([null])
    })

    it("the declared-key reader answers rev, cid, verifiedWith and CAR for v2 declarations", async () => {
        const did = `did:plc:${uniq().slice(0, 24)}`
        const { entry } = worstCase(did)
        await kvSnapshotStore(testEnv).putRecord(did, entry)
        const found: Awaited<ReturnType<typeof kvDeclaredKeyPage>>["records"] = []
        let cursor: string | undefined
        do {
            const page = await kvDeclaredKeyPage(testEnv, { limit: 50, ...(cursor ? { cursor } : {}) })
            found.push(...page.records)
            cursor = page.cursor ?? undefined
        } while (cursor)
        expect(found.find((r) => r.did === did)).toEqual({
            did,
            rev: entry.rev,
            cid: entry.cid,
            verifiedWith: entry.verifiedWith,
            car: entry.car,
        })
    })

    it("a secondary is stored as v2 with no policies, evidence or first-seen", async () => {
        const did = `did:plc:${uniq().slice(0, 24)}`
        const secondary = { did, collection: "app.bsky.actor.profile", rkey: "self" }
        await kvSnapshotStore(testEnv).putSecondary(secondary, {
            rev: "3m2",
            car: new Uint8Array([4, 5]),
            observedAtMs: 7,
            source: PDS,
            signingKey: "zKey",
            verifiedWith: "zKey",
            cid: "bafyreisecondary",
        })
        const meta = await metaOf(`rec:app.bsky.actor.profile/self:${did}`)
        expect(meta).toEqual({
            v: 2,
            rev: "3m2",
            cid: "bafyreisecondary",
            commitCid: null,
            verifiedWith: "zKey",
            observedAtMs: 7,
            evidence: null,
        })
        expect(await kvRecordSnapshots(testEnv).get(did, "app.bsky.actor.profile", "self")).toMatchObject({
            rev: "3m2",
            car: new Uint8Array([4, 5]),
        })
    })
})
