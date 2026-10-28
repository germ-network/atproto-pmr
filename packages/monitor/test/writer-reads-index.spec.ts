/**
 * Settle, refresh, the rotation push and registration retirement decide from
 * the index, never from a snapshot-store read.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { verifyRecordProofOutcome } from "@germ-network/atproto-pmr-core"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import { pushNewlySeenKey, settle, type FetchedRecord, type IngestDeps } from "../src/ingest"
import type { InterestDeps } from "../src/interest"
import { refreshDue, type RefreshDeps } from "../src/refresh"
import type {
    HeldDeclarationState,
    MonitorIndex,
    SecondarySnapshotStore,
    SnapshotEntry,
    SnapshotStore,
    SnapshotWriter,
} from "../src/storage"

const DID = "did:plc:alice"
const COLLECTION = "com.germnetwork.declaration"
const OLD_KEY = "zQ3shOldKeyOldKeyOldKeyOldKeyOldKeyOldKeyOldKey"
const NEW_KEY = "zQ3shNewKeyNewKeyNewKeyNewKeyNewKeyNewKeyNewKey"
const FP_A = "aa".repeat(32)
const FP_B = "bb".repeat(32)
const CAR = new Uint8Array([1, 2, 3])

function held(over: Partial<HeldDeclarationState> = {}): HeldDeclarationState {
    return {
        rev: "3m1",
        cid: "bafyreiheld",
        verifiedWith: OLD_KEY,
        commitCid: "bafyreiheldcommit",
        anchorKey: null,
        messagingKeyFingerprint: null,
        messagingKeyFirstSeenAtMs: null,
        seenKey: null,
        ...over,
    }
}

/**
 * A writer whose index holds `state`, over a snapshot store that fails the
 * test if it is read.
 */
function harness(state: HeldDeclarationState | null, opts: { verify?: IngestDeps["verify"]; fetch?: IngestDeps["fetchRecord"] } = {}) {
    let current = state
    const anchors = new Map<string, number>()
    const retainedAnchors: Array<readonly { identity: string; firstObservedAtMs: number }[]> = []
    const retainedKeys: Array<{ fingerprint: string; firstSeenAtMs: number | null; recordCid: string | null; rev: string | null }> = []
    const completed: Array<{ rev: string; written: unknown }> = []
    const deletions: Array<{ quiet: boolean | undefined }> = []
    const holderState = { value: current === null ? null : "held" } as { value: string | null }

    const index = {
        revOf: async () => current?.rev ?? null,
        holderStateOf: async () => holderState.value,
        heldDeclarationOf: async () => current,
        recordSeenKey: async (_did: string, key: string) => {
            if (current !== null) current = { ...current, seenKey: key }
        },
        getEvidenceAnchor: async (identity: string) => anchors.get(identity) ?? null,
        retainEvidenceAnchors: async (_did: string, rows: readonly { identity: string; firstObservedAtMs: number }[]) => {
            retainedAnchors.push(rows)
            for (const row of rows) if (!anchors.has(row.identity)) anchors.set(row.identity, row.firstObservedAtMs)
        },
        getMessagingKeyHistory: async () => null,
        retainMessagingKeyFirstSeen: async (_did: string, row: (typeof retainedKeys)[number]) => void retainedKeys.push(row),
        complete: async (_d: string, rev: string, _at: number, written: unknown) => void completed.push({ rev, written }),
        completeQuietly: async (_d: string, rev: string, _at: number, written: unknown) => void completed.push({ rev, written }),
        completeDeletion: async (_d: string, _at: number, _p: boolean, quiet?: boolean) => void deletions.push({ quiet }),
        clearPending: async () => {},
        markAttempted: async () => {},
        owedGenOf: async () => 1,
        isWatched: async () => true,
        isDeleted: async () => false,
    } as unknown as MonitorIndex

    const putRecord = vi.fn(async (_did: string, _e: SnapshotEntry) => {})
    const snapshot = {
        get getRecord(): never {
            throw new Error("the writer read the snapshot store")
        },
        putRecord,
        deleteRecord: async () => {},
    } as unknown as SnapshotWriter
    const onChange = vi.fn(async () => {})
    const deps: IngestDeps = {
        index,
        snapshot,
        fetchRecord: opts.fetch ?? (async () => ({ car: CAR, source: "https://pds.example", signingKey: NEW_KEY })),
        verify:
            opts.verify ??
            (async () => ({ kind: "verified", key: NEW_KEY, rev: "3m1", cid: "bafyreiheld", commitCid: "bafyreiheldcommit" })),
        interest: { inInterest: async () => true, interestEpoch: async () => 0 },
        nowMs: () => 5_000,
        onChange,
    }
    return { deps, index, putRecord, onChange, anchors, retainedAnchors, retainedKeys, completed, deletions, holderState, held: () => current }
}

describe("the writer never reads the snapshot store", () => {
    it("IngestDeps.snapshot is a SnapshotWriter, with no getRecord", () => {
        expectTypeOf<IngestDeps["snapshot"]>().toEqualTypeOf<SnapshotWriter>()
        expectTypeOf<IngestDeps["snapshot"]>().not.toHaveProperty("getRecord")
    })

    it("SnapshotWriter has no getRecord", () => {
        expectTypeOf<SnapshotWriter>().not.toHaveProperty("getRecord")
        expectTypeOf<IngestDeps>().toHaveProperty("snapshot")
    })

    it("a settle detects a signing-key rotation from the indexed verifiedWith", async () => {
        const anchorKey = Uint8Array.of(3, 9, 9)
        const h = harness(held({ verifiedWith: OLD_KEY }), {
            verify: async () => ({
                kind: "verified",
                key: NEW_KEY,
                rev: "3m1",
                cid: "bafyreiheld",
                commitCid: "bafyreinewcommit",
                anchorKey,
            }),
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(h.onChange).toHaveBeenCalledWith(DID, "3m1")
        expect(h.completed[0]!.written).toMatchObject({
            cid: "bafyreiheld",
            verifiedWith: NEW_KEY,
            commitCid: "bafyreinewcommit",
            anchorKey,
        })

        const same = harness(held({ verifiedWith: NEW_KEY }))
        expect(await settle(same.deps, DID)).toBe("stored")
        expect(same.onChange).not.toHaveBeenCalled()
    })

    it("a settle reuses first-observed evidence times from the index when the snapshot store is stale", async () => {
        const h = harness(held({ verifiedWith: NEW_KEY }), {
            verify: async () => ({
                kind: "verified",
                key: NEW_KEY,
                rev: "3m1",
                cid: "bafyreiheld",
                collection: COLLECTION,
                rkey: "self",
                commitCid: "bafyreiheldcommit",
                authority: { method: "plc", operationCid: "bafOperation" },
                assurance: "custody-chain",
                monitor: "monitor.example.org",
            }),
        })
        await settle(h.deps, DID)
        const first = h.putRecord.mock.calls[0]![1].evidence!
        expect(first).toMatchObject({ commitFirstObservedAtMs: 5_000, anchorFirstObservedAtMs: 5_000 })
        h.anchors.set(JSON.stringify(["anchor", DID, NEW_KEY, { method: "plc", operationCid: "bafOperation" }]), 1_000)
        await settle(h.deps, DID)
        expect(h.putRecord.mock.calls[1]![1].evidence).toMatchObject({ anchorFirstObservedAtMs: 1_000 })
    })

    it("a settle detects a messaging-key transition from the indexed fingerprint and keeps the old key as an unknown sentinel", async () => {
        const h = harness(held({ verifiedWith: NEW_KEY, messagingKeyFingerprint: FP_A }), {
            verify: async () => ({
                kind: "verified",
                key: NEW_KEY,
                rev: "3m1",
                cid: "bafyreinew",
                messagingKeyFingerprint: FP_B,
            }),
        })
        await settle(h.deps, DID)
        expect(h.retainedKeys[0]).toEqual({
            fingerprint: FP_A,
            firstSeenAtMs: null,
            recordCid: "bafyreiheld",
            commitCid: "bafyreiheldcommit",
            rev: "3m1",
            verifiedWith: NEW_KEY,
        })
        expect(h.retainedKeys[1]).toMatchObject({ fingerprint: FP_B, firstSeenAtMs: 5_000 })
        expect(h.putRecord.mock.calls[0]![1]).toMatchObject({
            messagingKeyFingerprint: FP_B,
            messagingKeyFirstSeenAtMs: 5_000,
        })
        expect(h.completed[0]!.written).toMatchObject({
            messagingKeyFingerprint: FP_B,
            messagingKeyFirstSeenAtMs: 5_000,
        })
    })

    it("a quiet refresh compares the fetched record CID to the indexed cid", async () => {
        const key = makeKey()
        const car = (n: number) =>
            buildRepoCar({
                did: DID,
                key,
                rev: n === 1 ? "3m1" : "3m2",
                records: { [`${COLLECTION}/self`]: { $type: COLLECTION, version: "1.1.0", n: 1 } },
            })
        const next = car(2)
        const cid = next.recordCids[`${COLLECTION}/self`]!
        const run = async (indexedCid: string) => {
            const h = harness(held({ rev: "3m1", cid: indexedCid, verifiedWith: key.multikey }))
            const quiet = vi.fn(async (..._args: unknown[]) => {})
            const fetched = { car: next.car, source: "https://pds.example", signingKey: key.multikey } as FetchedRecord
            h.deps.fetchRecord = async () => fetched
            h.deps.verify = async (did, record) => {
                const out = verifyRecordProofOutcome(record.car, {
                    did,
                    signingKey: record.signingKey!,
                    collection: COLLECTION,
                    rkey: "self",
                })
                return out.kind === "present"
                    ? {
                          kind: "verified",
                          key: record.signingKey!,
                          rev: out.rev,
                          cid: out.cid,
                          commitCid: "bafyreirefreshcommit",
                          anchorKey: Uint8Array.of(3, 7),
                      }
                    : { kind: "verified-absent", key: record.signingKey!, rev: out.rev }
            }
            const refreshIndex = {
                dueRefresh: async () => [DID],
                markChecked: async () => {},
                markAttempted: async () => {},
                completeQuietly: quiet,
            }
            const deps = {
                ingest: h.deps,
                refreshIndex,
                refreshSnapshots: { putCheck: async () => {} },
                fetchHeadRev: async () => ({ rev: "3m2", signingKey: key.multikey }),
                collection: COLLECTION,
                rkey: "self",
                secondary: { deps: {} as never, records: [] },
            } as unknown as RefreshDeps
            const result = await refreshDue(deps, { nowMs: 10_000_000, staleAfterMs: 3_600_000, limit: 64, nonHolderStaleAfterMs: 86_400_000 })
            return { result, quiet, h }
        }
        const same = await run(cid)
        expect(same.result.outcomes["advanced-quiet"]).toBe(1)
        expect(same.quiet).toHaveBeenCalledTimes(1)
        expect(same.quiet).toHaveBeenCalledWith(
            DID,
            "3m2",
            expect.any(Number),
            expect.objectContaining({ cid, commitCid: "bafyreirefreshcommit", anchorKey: Uint8Array.of(3, 7) })
        )
        const changed = await run("bafyreianothercid")
        expect(changed.result.outcomes["advanced-quiet"]).toBe(0)
        expect(changed.quiet).not.toHaveBeenCalled()
    })

    it("the rotation push records the seen key in the index and writes no snapshot", async () => {
        const h = harness(held({ verifiedWith: OLD_KEY }))
        await pushNewlySeenKey(h.deps, DID, NEW_KEY)
        expect(h.held()?.seenKey).toBe(NEW_KEY)
        expect(h.onChange).toHaveBeenCalledWith(DID, "3m1")
        expect(h.putRecord).not.toHaveBeenCalled()
    })

    it("the rotation push is sent once per newly seen key even when the snapshot store is stale", async () => {
        const h = harness(held({ verifiedWith: OLD_KEY }))
        await pushNewlySeenKey(h.deps, DID, NEW_KEY)
        await pushNewlySeenKey(h.deps, DID, NEW_KEY)
        expect(h.onChange).toHaveBeenCalledTimes(1)
        await pushNewlySeenKey(h.deps, DID, OLD_KEY)
        expect(h.onChange).toHaveBeenCalledTimes(1)
        await pushNewlySeenKey(h.deps, DID, "zQ3shAnotherKey")
        expect(h.onChange).toHaveBeenCalledTimes(2)
    })

    it("a repeated gone answer is quiet when the index holds the DID as gone", async () => {
        const absent: IngestDeps["verify"] = async () => ({ kind: "verified-absent", key: NEW_KEY, rev: "3m1" })
        const gone = harness(null, { verify: absent })
        gone.holderState.value = "gone-reversible"
        // Indexed rev stays, as completeDeletion leaves it.
        ;(gone.index as unknown as { revOf: () => Promise<string> }).revOf = async () => "3m1"
        await settle(gone.deps, DID)
        expect(gone.deletions).toEqual([{ quiet: true }])

        const fresh = harness(held(), { verify: absent })
        await settle(fresh.deps, DID)
        expect(fresh.deletions).toEqual([{ quiet: false }])
    })

    it("interest transitions reach the snapshot store only through deletes", () => {
        expectTypeOf<InterestDeps["snapshot"]>().toEqualTypeOf<
            Pick<SnapshotStore, "deleteRecord"> & Pick<SecondarySnapshotStore, "deleteSecondary">
        >()
    })

    it("a settle re-retains evidence anchors without a previous snapshot and keeps the first-observed times", async () => {
        const verify: IngestDeps["verify"] = async () => ({
            kind: "verified",
            key: NEW_KEY,
            rev: "3m2",
            cid: "bafyreinew",
            collection: COLLECTION,
            rkey: "self",
            commitCid: "bafyreinewcommit",
            authority: { method: "plc", operationCid: "bafOperation" },
            assurance: "custody-chain",
            monitor: "monitor.example.org",
        })
        const h = harness(null, { verify })
        h.anchors.set(JSON.stringify(["anchor", DID, NEW_KEY, { method: "plc", operationCid: "bafOperation" }]), 1_000)
        await settle(h.deps, DID)
        expect(h.retainedAnchors).toHaveLength(1)
        expect(h.retainedAnchors[0]).toMatchObject([
            { firstObservedAtMs: 5_000 },
            { firstObservedAtMs: 1_000 },
        ])
    })
})
