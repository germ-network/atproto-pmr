import { describe, expect, it } from "vitest"
import { prepareSnapshotEvidence, retainSnapshotEvidence } from "../src/ingest"
import type { EvidenceAnchorRow, MonitorIndex } from "../src/storage"

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
    const writes: Array<{ did: string; rows: readonly EvidenceAnchorRow[] }> = []
    const index = {
        async getEvidenceAnchor(identity: string) {
            return anchors.get(identity) ?? null
        },
        async retainEvidenceAnchors(did: string, rows: readonly EvidenceAnchorRow[]) {
            writes.push({ did, rows })
            for (const row of rows) {
                if (!anchors.has(row.identity)) anchors.set(row.identity, row.firstObservedAtMs)
            }
        },
    } as unknown as MonitorIndex
    return { index, anchors, writes }
}

describe("summary evidence anchors", () => {
    it("retains the first observation through assurance upgrades and commit changes", async () => {
        const { index } = evidenceIndex()
        const first = await prepareSnapshotEvidence(index, "did:plc:alice", verified(), 1_000)
        expect(first).not.toBeNull()
        await retainSnapshotEvidence(index, first!)

        const upgraded = await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ assurance: "custody-chain" }),
            2_000
        )
        expect(upgraded).toMatchObject({
            assurance: "custody-chain",
            commitFirstObservedAtMs: 1_000,
            anchorFirstObservedAtMs: 1_000,
        })
        await retainSnapshotEvidence(index, upgraded!)

        // The anchor comes from what the index retained.
        const nextCommit = await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ commitCid: "bafCommit2", rev: "3m2", cid: "bafRecord2" }),
            3_000
        )
        expect(nextCommit).toMatchObject({
            commitFirstObservedAtMs: 3_000,
            anchorFirstObservedAtMs: 1_000,
        })
    })

    it("retains each settle's anchors, keeping the first observation of an identity it has seen", async () => {
        const { index, writes } = evidenceIndex()
        const first = (await prepareSnapshotEvidence(index, "did:plc:alice", verified(), 1_000))!
        await retainSnapshotEvidence(index, first)
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({
            did: "did:plc:alice",
            rows: [
                { kind: "commit", firstObservedAtMs: 1_000 },
                { kind: "anchor", firstObservedAtMs: 1_000 },
            ],
        })

        const upgraded = (await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ assurance: "custody-chain" }),
            2_000
        ))!
        await retainSnapshotEvidence(index, upgraded)
        expect(writes).toHaveLength(2)

        const nextCommit = (await prepareSnapshotEvidence(
            index,
            "did:plc:alice",
            verified({ commitCid: "bafCommit2", rev: "3m2", cid: "bafRecord2" }),
            3_000
        ))!
        await retainSnapshotEvidence(index, nextCommit)
        expect(writes).toHaveLength(3)
        expect(writes[2]!.rows).toMatchObject([
            { kind: "commit", firstObservedAtMs: 3_000 },
            { kind: "anchor", firstObservedAtMs: 1_000 },
        ])
    })

    it("returns unavailable evidence when the proof lacks method authority", async () => {
        const { index } = evidenceIndex()
        expect(
            await prepareSnapshotEvidence(
                index,
                "did:plc:alice",
                verified({ authority: undefined }) as ReturnType<typeof verified>,
                1_000
            )
        ).toBeNull()
    })
})
