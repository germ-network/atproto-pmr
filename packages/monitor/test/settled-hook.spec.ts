import { heldFromEntries } from "./held-from-entries"
import { describe, expect, it } from "vitest"
import { RecordNotFoundError, verifyRecordProofOutcome } from "@germ-network/atproto-pmr-core"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import { applyInterestTransitions } from "../src/interest"
import { settle, type FetchedRecord, type IngestDeps, type SettledDeclaration } from "../src/ingest"
import { refreshDue, type RefreshDeps } from "../src/refresh"
import type { MonitorIndex, SnapshotEntry, SnapshotStore } from "../src/storage"

const DID = "did:plc:alice"
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const CAR = new Uint8Array([1, 2, 3])

function harness(opts: {
    indexed?: string
    verify?: IngestDeps["verify"]
    fetchRecord?: IngestDeps["fetchRecord"]
    onSettled?: IngestDeps["onSettled"]
} = {}) {
    const events: string[] = []
    const settled: Array<{ did: string; settled: SettledDeclaration | null }> = []
    let rev = opts.indexed ?? null
    const records = new Map<string, SnapshotEntry>()
    const index = {
        revOf: async () => rev,
        ...heldFromEntries(records),
        holderStateOf: async () => (rev === null ? null : "held"),
        owedGenOf: async () => 1,
        complete: async (_d: string, r: string) => {
            rev = r
            events.push("index:complete")
        },
        completeQuietly: async (_d: string, r: string) => {
            rev = r
            events.push("index:completeQuietly")
        },
        completeDeletion: async () => void events.push("index:completeDeletion"),
        clearPending: async () => void events.push("index:clearPending"),
        markAttempted: async () => {},
        isWatched: async () => true,
        deferPending: async () => 1,
    } as unknown as MonitorIndex
    const snapshot = {
        getRecord: async (did: string) => records.get(did) ?? null,
        putRecord: async (did: string, e: SnapshotEntry) => void records.set(did, e),
        deleteRecord: async (did: string) => void records.delete(did),
    } as unknown as SnapshotStore
    const deps: IngestDeps = {
        index,
        snapshot,
        fetchRecord:
            opts.fetchRecord ??
            (async () => ({ car: CAR, source: "https://pds.example", signingKey: KEY })),
        verify:
            opts.verify ??
            (async () => ({ kind: "verified", key: KEY, rev: "3m2", cid: "bafyreicid" })),
        interest: { inInterest: async () => true, interestEpoch: async () => 0 },
        nowMs: () => 1_000,
        onChange: async () => void events.push("onChange"),
        onDelete: async () => void events.push("onDelete"),
        onRegression: async () => void events.push("onRegression"),
        onSettled:
            opts.onSettled ??
            (async (did, s) => {
                settled.push({ did, settled: s })
                events.push("onSettled")
            }),
    }
    return { deps, events, settled, records }
}

const absent: IngestDeps["verify"] = async () => ({ kind: "verified-absent", key: KEY, rev: "3m2" })

describe("onSettled", () => {
    it("fires with rev, cid and the stored CAR after an advancing settle's discharge", async () => {
        const h = harness()
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(h.settled).toEqual([
            { did: DID, settled: { rev: "3m2", cid: "bafyreicid", car: CAR } },
        ])
        expect(h.settled[0]!.settled!.car).toBe(h.records.get(DID)!.car)
    })

    it("fires for a quiet (join-owed) settle, which raises no onChange", async () => {
        const h = harness()
        expect(await settle(h.deps, DID, { quiet: true })).toBe("stored")
        expect(h.settled).toHaveLength(1)
        expect(h.events).toEqual(["index:completeQuietly", "onSettled"])
    })

    it("fires for a quiet refresh that stores the record without a settle", async () => {
        const key = makeKey()
        const COLLECTION = "com.germnetwork.declaration"
        const car = (rev: string) =>
            buildRepoCar({
                did: DID,
                key,
                rev,
                records: {
                    [`${COLLECTION}/self`]: { $type: COLLECTION, version: "1.1.0", n: 1 },
                    ...(rev === "3m2" ? { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } } : {}),
                },
            }).car
        const stored = { car: car("3m1"), source: "https://pds.example", signingKey: key.multikey }
        const next = { car: car("3m2"), source: "https://pds.example", signingKey: key.multikey }
        const settled: Array<SettledDeclaration | null> = []
        const order: string[] = []
        let rev = "3m1"
        const records = new Map<string, SnapshotEntry>([
            [DID, { ...stored, rev: "3m1", observedAtMs: 1, verifiedWith: key.multikey, cid: "bafyreistored" } as SnapshotEntry],
        ])
        const index = {
            revOf: async () => rev,
            ...heldFromEntries(records),
            holderStateOf: async () => "held",
            recordsOf: async () => [],
            isWatched: async () => true,
            isDeleted: async () => false,
            owedGenOf: async () => null,
        } as unknown as MonitorIndex
        const ingest: IngestDeps = {
            index,
            snapshot: {
                getRecord: async (d: string) => records.get(d) ?? null,
                putRecord: async (d: string, e: SnapshotEntry) => void records.set(d, e),
            } as unknown as SnapshotStore,
            fetchRecord: async () => next as FetchedRecord,
            verify: async (did, record) => {
                const out = verifyRecordProofOutcome(record.car, {
                    did,
                    signingKey: record.signingKey!,
                    collection: COLLECTION,
                    rkey: "self",
                })
                return out.kind === "present"
                    ? { kind: "verified", key: record.signingKey!, rev: out.rev, cid: out.cid }
                    : { kind: "verified-absent", key: record.signingKey!, rev: out.rev }
            },
            interest: { inInterest: async () => true, interestEpoch: async () => 0 },
            nowMs: () => 10_000_000,
            onSettled: async (_d, s) => void (settled.push(s), order.push("onSettled")),
        }
        const deps = {
            ingest,
            refreshIndex: {
                dueRefresh: async () => [DID],
                markChecked: async () => {},
                markAttempted: async () => {},
                completeQuietly: async (_d: string, r: string) => void ((rev = r), order.push("completeQuietly")),
            },
            refreshSnapshots: { putCheck: async () => {} },
            fetchHeadRev: async () => ({ rev: "3m2", signingKey: key.multikey }),
            collection: COLLECTION,
            rkey: "self",
            secondary: { deps: {} as never, records: [] },
        } as unknown as RefreshDeps
        const result = await refreshDue(deps, {
            nowMs: 10_000_000,
            staleAfterMs: 3_600_000,
            limit: 64,
            nonHolderStaleAfterMs: 86_400_000,
        })
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(settled).toEqual([{ rev: "3m2", cid: expect.stringMatching(/^bafyrei/), car: next.car }])
        expect(order).toEqual(["completeQuietly", "onSettled"])
    })

    it("fires with null after a deletion, quiet or not", async () => {
        const gone = async () => {
            throw new RecordNotFoundError("RecordNotFound", false)
        }
        const loud = harness({ indexed: "3m1", fetchRecord: gone })
        await settle(loud.deps, DID)
        expect(loud.settled).toEqual([{ did: DID, settled: null }])

        const quiet = harness({ indexed: "3m1", fetchRecord: gone })
        await settle(quiet.deps, DID, { quiet: true })
        expect(quiet.settled).toEqual([{ did: DID, settled: null }])

        const absentLoud = harness({ indexed: "3m1", verify: absent })
        await settle(absentLoud.deps, DID)
        expect(absentLoud.settled).toEqual([{ did: DID, settled: null }])
    })

    const leave = async (throws: boolean) => {
        const calls: string[] = []
        const raised: Array<[string, SettledDeclaration | null]> = []
        const applied = await applyInterestTransitions(
            {
                interest: {
                    dueTransitions: async () => [{ did: DID, epoch: 2, change: "leave" }],
                    interestEpoch: async () => 2,
                    clearTransition: async () => void calls.push("clearTransition"),
                    forgetLeft: async () => void calls.push("forgetLeft"),
                },
                index: { recordsOf: async () => [] },
                snapshot: {
                    deleteRecord: async () => void calls.push("deleteRecord"),
                    deleteSecondary: async () => {},
                },
                secondaries: [],
                nowMs: () => 1,
                onSettled: async (did: string, s: SettledDeclaration | null) =>
                    {
                        calls.push("onSettled")
                        raised.push([did, s])
                        if (throws) throw new Error("index down")
                    },
            } as never,
            10
        )
        return { applied, raised, calls }
    }

    it("fires with null after an interest leave disposes of the DID", async () => {
        const { applied, raised, calls } = await leave(false)
        expect(applied).toBe(1)
        expect(raised).toEqual([[DID, null]])
        expect(calls).toEqual(["deleteRecord", "forgetLeft", "onSettled", "clearTransition"])
    })

    it("a throwing onSettled does not hold a leave open", async () => {
        const { applied, calls } = await leave(true)
        expect(applied).toBe(1)
        expect(calls).toContain("clearTransition")
    })

    it("does not fire for a regression or an unverifiable fetch", async () => {
        const regressed = harness({ indexed: "3m9" })
        expect(await settle(regressed.deps, DID)).toBe("rejected")
        expect(regressed.settled).toEqual([])

        const unverifiable = harness({
            indexed: "3m1",
            verify: async () => ({ kind: "unverifiable" }),
        })
        unverifiable.records.set(DID, {
            rev: "3m1",
            car: CAR,
            observedAtMs: 1,
            source: "https://pds.example",
            signingKey: "zOld",
            verifiedWith: "zOld",
            cid: "bafyreiold",
        } as SnapshotEntry)
        expect(await settle(unverifiable.deps, DID)).toBe("unverifiable")
        expect(unverifiable.settled).toEqual([])
        expect((await unverifiable.deps.index.heldDeclarationOf(DID))?.seenKey).toBe(KEY)
    })

    it("a throw is swallowed and the settle still discharges", async () => {
        const h = harness({
            onSettled: async () => {
                throw new Error("index down")
            },
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(h.events).toEqual(["index:complete", "onChange"])

        const del = harness({
            indexed: "3m1",
            verify: absent,
            onSettled: async () => {
                throw new Error("index down")
            },
        })
        expect(await settle(del.deps, DID)).toBe("deleted")
        expect(del.events).toEqual(["index:completeDeletion", "onDelete"])
    })

    it("fires after the index write and before onChange", async () => {
        const h = harness()
        await settle(h.deps, DID)
        expect(h.events).toEqual(["index:complete", "onSettled", "onChange"])

        const del = harness({ indexed: "3m1", verify: absent })
        await settle(del.deps, DID)
        expect(del.events).toEqual(["index:completeDeletion", "onSettled", "onDelete"])
    })
})
