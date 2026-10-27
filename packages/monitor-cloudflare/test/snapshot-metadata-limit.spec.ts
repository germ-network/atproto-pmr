/**
 * A snapshot's KV metadata stays under KV's 1024-byte cap, which miniflare
 * enforces: past it the put is a 413 and the declaration is never stored.
 */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry, SnapshotEvidence } from "@germ-network/atproto-pmr-monitor"
import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import type { MonitorEnv } from "../src/env"
import {
    KV_METADATA_MAX_BYTES,
    kvRecordSnapshots,
    kvSnapshotStore,
    kvSummaryIndexReader,
} from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv

/** A did:web on a long hostname, unique per test since KV is shared across tests. */
const longDid = () =>
    `did:web:${crypto.randomUUID().replaceAll("-", "")}.users.long-subdomain-of-a-hosting-provider.example.com`

const cid = (c: string) => `bafyrei${c.repeat(52)}`
const multibaseKey = (c: string) => `zQ3sh${c.repeat(44)}`
const PDS = "https://hebeloma-chanterelle-morel.us-west.host.bsky.network"

/** A keyPackage with no succession proofs and the `follows` policy byte. */
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

const webAuthority = (did: string): SnapshotEvidence["authority"] => ({
    method: "web",
    documentUrl: `https://${did.slice("did:web:".length)}/.well-known/did.json`,
    verificationMethodId: `${did}#atproto`,
    keyFingerprint: `sha256:${"e".repeat(64)}`,
})

function worstCase(
    did: string,
    authority: SnapshotEvidence["authority"] = plcAuthority
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
        monitor: "monitor.long-subdomain-of-a-hosting-provider.example.com",
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
            seenKey: multibaseKey("s"),
            evidence,
            messagingKeyFingerprint: "f".repeat(64),
            messagingKeyFirstSeenAtMs: 1_793_000_000_000,
        },
    }
}

const metadataBytes = (metadata: unknown) => new TextEncoder().encode(JSON.stringify(metadata)).byteLength

afterEach(() => vi.restoreAllMocks())

describe("snapshot metadata under the KV cap", () => {
    it("stores a worst-case declaration and reads back its full evidence", async () => {
        const warned = vi.spyOn(console, "warn")
        const did = longDid()
        const { entry, evidence } = worstCase(did)
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, entry)

        const read = await store.getRecord(did)
        expect(read!.evidence).toEqual(evidence)
        expect(read!.messagingKeyFingerprint).toBe(entry.messagingKeyFingerprint)
        expect(read!.messagingKeyFirstSeenAtMs).toBe(entry.messagingKeyFirstSeenAtMs)
        expect((await kvRecordSnapshots(testEnv).get(did, DECLARATION_COLLECTION_NSID, "self"))!.evidence)
            .toEqual(evidence)
        expect(warned).not.toHaveBeenCalledWith("monitor: snapshot metadata trimmed", expect.anything())

        const { metadata } = await testEnv.records.getWithMetadata(`rec:${did}`)
        expect(metadata).toHaveProperty("policies", { found: true, policies: ["bsky-follows"] })
        expect(metadataBytes(metadata)).toBeLessThanOrEqual(KV_METADATA_MAX_BYTES)
    })

    it("stores a worst-case did:web declaration and reads back its full evidence", async () => {
        const warned = vi.spyOn(console, "warn")
        const did = longDid()
        const { entry, evidence } = worstCase(did, webAuthority(did))
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, entry)

        expect((await store.getRecord(did))!.evidence).toEqual(evidence)
        expect(warned).not.toHaveBeenCalledWith("monitor: snapshot metadata trimmed", expect.anything())
        const { metadata } = await testEnv.records.getWithMetadata(`rec:${did}`)
        expect(metadataBytes(metadata)).toBeLessThanOrEqual(KV_METADATA_MAX_BYTES)
    })

    it("keeps a did:web authority the DID does not imply", async () => {
        const did = longDid()
        const authority: SnapshotEvidence["authority"] = {
            method: "web",
            documentUrl: "https://elsewhere.example/.well-known/did.json",
            verificationMethodId: "#atproto",
            keyFingerprint: `sha256:${"e".repeat(64)}`,
        }
        const { entry, evidence } = worstCase(did, authority)
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, { ...entry, messagingKeyFingerprint: null, messagingKeyFirstSeenAtMs: null })
        expect((await store.getRecord(did))!.evidence).toEqual(evidence)
    })

    it("reads evidence stored in the full legacy shape", async () => {
        const did = `did:plc:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
        const { entry, evidence } = worstCase(did)
        await testEnv.records.put(`rec:${did}`, entry.car, {
            metadata: {
                rev: entry.rev,
                commitCid: entry.commitCid,
                observedAtMs: entry.observedAtMs,
                source: "s",
                signingKey: "zKey",
                verifiedWith: entry.verifiedWith,
                cid: entry.cid,
                seenKey: null,
                evidence,
            },
        })
        expect((await kvSnapshotStore(testEnv).getRecord(did))!.evidence).toEqual(evidence)
        const [summary] = await kvSummaryIndexReader(testEnv).entries([ref(did)])
        expect(summary!.evidenceState).toEqual(evidence)
    })

    it("trims optional metadata rather than fail the put", async () => {
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {})
        const did = longDid()
        const { entry } = worstCase(did)
        const oversized = { ...entry, source: `https://${"p".repeat(460)}.example` }
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, oversized)

        const read = await store.getRecord(did)
        expect(read!.rev).toBe(entry.rev)
        expect(read!.cid).toBe(entry.cid)
        expect(read!.signingKey).toBe(entry.signingKey)
        expect(read!.verifiedWith).toBe(entry.verifiedWith)
        expect(read!.evidence).toBeNull()
        expect(read!.messagingKeyFirstSeenAtMs).toBeNull()
        expect(read!.messagingKeyFingerprint).toBeNull()
        const { metadata } = await testEnv.records.getWithMetadata(`rec:${did}`)
        expect(metadata).toHaveProperty("policies", { found: true, policies: ["bsky-follows"] })
        expect(warned).toHaveBeenCalledWith(
            "monitor: snapshot metadata trimmed",
            expect.objectContaining({ key: `rec:${did}` })
        )
    })

    it("trims only as much as the cap needs", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const did = longDid()
        const { entry } = worstCase(did)
        const store = kvSnapshotStore(testEnv)
        await store.putRecord(did, { ...entry, source: `https://${"p".repeat(200)}.example` })

        const read = await store.getRecord(did)
        expect(read!.evidence).toBeNull()
        expect(read!.messagingKeyFingerprint).toBe(entry.messagingKeyFingerprint)
        expect(read!.messagingKeyFirstSeenAtMs).toBe(entry.messagingKeyFirstSeenAtMs)
    })

    it("the summary reader rebuilds evidence from the slim shape", async () => {
        const did = longDid()
        const { entry, evidence } = worstCase(did)
        await kvSnapshotStore(testEnv).putRecord(did, entry)
        const [summary] = await kvSummaryIndexReader(testEnv).entries([ref(did)])
        expect(summary!.evidenceState).toEqual(evidence)
        expect(summary!.messagingKeyFirstSeenAtMs).toBe(entry.messagingKeyFirstSeenAtMs)
    })
})
