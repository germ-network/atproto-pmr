import { describe, expect, it } from "vitest"
import { prepareSnapshotEvidence, retainSnapshotEvidence } from "../src/ingest"
import type { MonitorIndex } from "../src/storage"

const verified = (overrides: Record<string, unknown> = {}) => ({
    kind: "verified" as const,
    key: "zSigningKey",
    rev: "3m1",
    cid: "bafRecord",
    collection: "com.germnetwork.declaration",
    rkey: "self",
    commitCid: "bafCommit1",
    authority: { method: "plc" as const, operationCid: "bafOperation1" },
    assurance: "current-key-cross-check" as const,
    monitor: "monitor.example.org",
    ...overrides,
})

function evidenceIndex() {
    const anchors = new Map<string, number>()
    const index = {
        async getEvidenceAnchor(identity: string) {
            return anchors.get(identity) ?? null
        },
        async retainEvidenceAnchor(identity: string, observedAtMs: number) {
            const retained = anchors.get(identity) ?? observedAtMs
            anchors.set(identity, retained)
            return retained
        },
    } as unknown as MonitorIndex
    return { index, anchors }
}

describe("summary evidence anchors", () => {
    it("retains the first observation through assurance upgrades and commit changes", async () => {
        const { index } = evidenceIndex()
        const first = await prepareSnapshotEvidence(index, "did:plc:alice", verified(), null, 1_000)
        expect(first).not.toBeNull()
        await retainSnapshotEvidence(index, first!)

        const upgraded = await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ assurance: "custody-chain" }),
            first,
            2_000
        )
        expect(upgraded).toMatchObject({
            assurance: "custody-chain",
            commitFirstObservedAtMs: 1_000,
            anchorFirstObservedAtMs: 1_000,
        })

        const nextCommit = await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ commitCid: "bafCommit2", rev: "3m2", cid: "bafRecord2" }),
            upgraded,
            3_000
        )
        expect(nextCommit).toMatchObject({
            commitFirstObservedAtMs: 3_000,
            anchorFirstObservedAtMs: 1_000,
        })
    })

    it("returns unavailable evidence when the proof lacks method authority", async () => {
        const { index } = evidenceIndex()
        expect(
            await prepareSnapshotEvidence(
                index,
                "did:plc:alice",
                verified({ authority: undefined }) as ReturnType<typeof verified>,
                null,
                1_000
            )
        ).toBeNull()
    })
})
