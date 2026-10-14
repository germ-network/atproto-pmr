/**
 * Secondary records settle quietly: verified before anything is stored,
 * never written over a newer rev, and never a digest-window entry, a push or
 * a `revs` change.
 */
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import { settle, type FetchedRecord, type IngestDeps, type VerifyOutcome } from "../src/ingest"
import { settleSecondary, settleSecondaryDue, type SecondaryDeps } from "../src/secondary"
import type {
    MonitorIndex,
    PendingRecordFetch,
    RecordRef,
    SecondaryWriteAnswer,
    SnapshotEntry,
    SnapshotStore,
} from "../src/storage"

const DID = "did:plc:alice"
const COLLECTION = "app.bsky.actor.profile"
const REF: RecordRef = { did: DID, collection: COLLECTION, rkey: "self" }
const KEY = "zKey"
const OWED: PendingRecordFetch = { ...REF, rev: "", attempts: 0, notBeforeMs: 0, epoch: 1 }

const entry = (rev: string): SnapshotEntry => ({
    rev,
    car: new Uint8Array([rev.length]),
    observedAtMs: 1,
    source: "s",
    signingKey: KEY,
    verifiedWith: KEY,
    cid: "bafyreistored",
})

function harness(
    opts: {
        indexedRev?: string
        stored?: SnapshotEntry
        inInterest?: boolean
        epoch?: number
        fetch?: () => Promise<FetchedRecord>
        verify?: VerifyOutcome
        complete?: SecondaryWriteAnswer | "stored"
    } = {}
) {
    let stored = opts.stored ?? null
    let indexedRev = opts.indexedRev ?? null
    let epoch = opts.epoch ?? 1
    const calls: string[] = []
    const owedRevs: string[] = []
    const deps: SecondaryDeps = {
        index: {
            dueSecondaries: async () => [OWED],
            deferSecondary: async () => void calls.push("defer"),
            clearSecondary: async (_ref, owedRev) => {
                calls.push("clear")
                owedRevs.push(owedRev)
            },
            completeSecondary: async (_ref, rev, _verified, _epoch, owedRev) => {
                calls.push("complete")
                owedRevs.push(owedRev)
                const answer = opts.complete ?? "stored"
                if (answer === "stored") indexedRev = rev
                return answer
            },
            disposeSecondary: async (_ref, _rev, _epoch, owedRev) => {
                calls.push("dispose")
                owedRevs.push(owedRev)
                indexedRev = null
                return "disposed"
            },
            secondaryRevOf: async () => indexedRev,
            forgetSecondaries: async () => {},
        },
        interest: {
            inInterest: async () => opts.inInterest ?? true,
            interestEpoch: async () => epoch,
        },
        snapshot: {
            getSecondary: async () => stored,
            putSecondary: async (_r, e) => {
                calls.push("put")
                stored = e
            },
            deleteSecondary: async () => {
                calls.push("delete")
                stored = null
            },
            putSecondaryCheck: async () => {},
        },
        fetchRecord:
            opts.fetch ??
            (async () => ({ car: new Uint8Array([9]), source: "https://pds", signingKey: KEY })),
        verify: async () => opts.verify ?? { kind: "verified", key: KEY, rev: "3m5", cid: "bafyreinew" },
        deferToDeclaration: async () => void calls.push("defer-declaration"),
        nowMs: () => 1_000,
    }
    return { deps, calls, owedRevs, stored: () => stored, indexedRev: () => indexedRev, setEpoch: (n: number) => (epoch = n) }
}

describe("settleSecondary", () => {
    it("settles without window, onChange or revs change", async () => {
        const h = harness()
        expect(await settleSecondary(h.deps, OWED)).toBe("stored")
        expect(h.stored()).toMatchObject({
            rev: "3m5",
            verifiedWith: KEY,
            cid: "bafyreinew",
            observedAtMs: 1_000,
        })
        expect(h.indexedRev()).toBe("3m5")
        // Bytes first, then the index.
        expect(h.calls).toEqual(["put", "complete"])
    })

    it("older rev never overwrites a newer stored secondary", async () => {
        const newer = entry("3m9")
        const h = harness({ stored: newer, indexedRev: "3m9" })
        expect(await settleSecondary(h.deps, OWED)).toBe("older")
        expect(h.stored()).toBe(newer)
        expect(h.indexedRev()).toBe("3m9")
    })

    it("verified absence at a current rev deletes only the secondary", async () => {
        const h = harness({
            stored: entry("3m3"),
            indexedRev: "3m3",
            verify: { kind: "verified-absent", key: KEY, rev: "3m5" },
        })
        expect(await settleSecondary(h.deps, OWED)).toBe("deleted")
        expect(h.stored()).toBeNull()
        // The KV entry goes before the index row.
        expect(h.calls).toEqual(["delete", "dispose"])

        const older = harness({
            stored: entry("3m9"),
            indexedRev: "3m9",
            verify: { kind: "verified-absent", key: KEY, rev: "3m5" },
        })
        expect(await settleSecondary(older.deps, OWED)).toBe("older")
        expect(older.stored()).not.toBeNull()
    })

    it("repo-level not-found on a secondary does not delete it directly", async () => {
        const gone = harness({
            stored: entry("3m3"),
            indexedRev: "3m3",
            fetch: async () => {
                throw new RecordNotFoundError("repo gone", true, "RepoNotFound")
            },
        })
        expect(await settleSecondary(gone.deps, OWED)).toBe("deferred")
        expect(gone.stored()).not.toBeNull()
        expect(gone.calls).toEqual(["clear", "defer-declaration"])

        // A record-level answer carries no proof, so it disposes nothing either.
        const missing = harness({
            stored: entry("3m3"),
            indexedRev: "3m3",
            fetch: async () => {
                throw new RecordNotFoundError("no record", true, "RecordNotFound")
            },
        })
        expect(await settleSecondary(missing.deps, OWED)).toBe("unverifiable")
        expect(missing.stored()).not.toBeNull()
        expect(missing.calls).toEqual(["clear"])
    })

    it("unverifiable secondary keeps the previous entry", async () => {
        const previous = entry("3m3")
        const h = harness({ stored: previous, indexedRev: "3m3", verify: { kind: "unverifiable" } })
        expect(await settleSecondary(h.deps, OWED)).toBe("unverifiable")
        expect(h.stored()).toBe(previous)
        expect(h.calls).toEqual(["clear"])
    })

    it("a secondary older than the indexed rev is not written to KV", async () => {
        const h = harness({ indexedRev: "3m9" })
        expect(await settleSecondary(h.deps, OWED)).toBe("older")
        expect(h.calls).not.toContain("put")
    })

    it("a secondary whose DID left interest after its put has that KV entry deleted", async () => {
        const h = harness({ complete: "left" })
        expect(await settleSecondary(h.deps, OWED)).toBe("left")
        expect(h.calls).toEqual(["put", "complete", "delete"])
        expect(h.stored()).toBeNull()
    })

    it("a secondary settle for a DID not in interest stores nothing", async () => {
        for (const h of [harness({ inInterest: false }), harness({ epoch: 2 })]) {
            expect(await settleSecondary(h.deps, OWED)).toBe("left")
            expect(h.calls).toEqual(["clear"])
            expect(h.stored()).toBeNull()
        }
        // Left while the fetch was in flight.
        const h = harness()
        const fetch = h.deps.fetchRecord
        h.deps.fetchRecord = async (ref) => {
            h.setEpoch(2)
            return fetch(ref)
        }
        expect(await settleSecondary(h.deps, OWED)).toBe("left")
        expect(h.calls).not.toContain("put")
    })

    it("every exit settles only the rev it was owed, never the verified one", async () => {
        const owed = { ...OWED, rev: "3m2" }
        const notFound = (reason: string) => async () => {
            throw new RecordNotFoundError("gone", true, reason)
        }
        const exits = [
            harness(), // stored
            harness({ complete: "left" }),
            harness({ inInterest: false }), // left before the fetch
            harness({ indexedRev: "3m9" }), // older
            harness({ verify: { kind: "unverifiable" } }),
            harness({ fetch: notFound("RecordNotFound") }),
            harness({ fetch: notFound("RepoNotFound") }), // deferred
            harness({ stored: entry("3m3"), indexedRev: "3m3", verify: { kind: "verified-absent", key: KEY, rev: "3m5" } }), // deleted
        ]
        for (const h of exits) {
            await settleSecondary(h.deps, owed)
            expect(h.owedRevs).toEqual(["3m2"])
        }
    })

    it("a transient failure is deferred with backoff, not dropped", async () => {
        const h = harness({
            fetch: async () => {
                throw new Error("pds down")
            },
        })
        expect(await settleSecondaryDue(h.deps)).toBe(0)
        expect(h.calls).toEqual(["defer"])
    })
})

describe("a repo-level answer on the declaration path", () => {
    function declarationDeps(
        error: RecordNotFoundError | "absent",
        held = true
    ) {
        const dispose = vi.fn(async () => {})
        const onDelete = vi.fn(async () => {})
        const completeDeletion = vi.fn(async () => {})
        const clearPending = vi.fn(async () => {})
        const deps = {
            index: {
                revOf: async () => (held ? "3m1" : null),
                holderStateOf: async () => (held ? "held" : null),
                completeDeletion,
                clearPending,
                isWatched: async () => true,
            } as unknown as MonitorIndex,
            snapshot: { deleteRecord: async () => {} } as unknown as SnapshotStore,
            fetchRecord: async () => {
                if (error !== "absent") throw error
                return { car: new Uint8Array([1]), source: "s", signingKey: KEY }
            },
            verify: async () =>
                error === "absent"
                    ? ({ kind: "verified-absent" as const, key: KEY, rev: "3m1" })
                    : ({ kind: "unverifiable" as const }),
            interest: { inInterest: async () => true, interestEpoch: async () => 1 },
            secondaries: { dispose },
            onDelete,
            nowMs: () => 1,
        } satisfies IngestDeps
        return { deps, dispose, onDelete, completeDeletion, clearPending }
    }

    it("a repo-level deletion disposes the profile", async () => {
        for (const reason of ["RepoNotFound", "RepoTakendown", "RepoSuspended", "RepoDeactivated"]) {
            const h = declarationDeps(new RecordNotFoundError("gone", true, reason))
            expect(await settle(h.deps, DID)).toBe("deleted")
            expect(h.dispose).toHaveBeenCalledWith(DID)
            expect(h.onDelete).toHaveBeenCalledWith(DID)
        }
        const record = declarationDeps(new RecordNotFoundError("no record", true, "RecordNotFound"))
        await settle(record.deps, DID)
        expect(record.dispose).not.toHaveBeenCalled()
    })

    it("a null not-found reason (did:plc tombstone) counts as repo-level", async () => {
        const h = declarationDeps(new RecordNotFoundError("tombstoned", true))
        await settle(h.deps, DID)
        expect(h.dispose).toHaveBeenCalledWith(DID)
    })

    it("a quiet settle for a DID that never held a declaration records nothing", async () => {
        const absent = declarationDeps("absent", false)
        expect(await settle(absent.deps, DID, { quiet: true })).toBe("deleted")
        expect(absent.completeDeletion).not.toHaveBeenCalled()
        expect(absent.clearPending).toHaveBeenCalledWith(DID)
        expect(absent.dispose).not.toHaveBeenCalled()

        const repo = declarationDeps(new RecordNotFoundError("gone", true, "RepoNotFound"), false)
        expect(await settle(repo.deps, DID, { quiet: true })).toBe("deleted")
        expect(repo.completeDeletion).not.toHaveBeenCalled()
        expect(repo.dispose).toHaveBeenCalledWith(DID)

        // Quiet is what makes it so: a real obligation is still recorded.
        const loud = declarationDeps("absent", false)
        await settle(loud.deps, DID)
        expect(loud.completeDeletion).toHaveBeenCalled()
    })
})
