/**
 * Secondary records settle quietly: verified before anything is stored,
 * never written over a newer rev, and never a digest-window entry, a push or
 * a `revs` change.
 */
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    PENDING_FAILURE_MESSAGE_MAX,
    SETTLE_RETRY_CAP_MS,
    settle,
    type FetchedRecord,
    type IngestDeps,
    type VerifyOutcome,
} from "../src/ingest"
import {
    settleSecondary,
    settleSecondaryDue,
    type SecondaryDeps,
    type SecondarySettleFailureEvent,
} from "../src/secondary"
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
        owed?: PendingRecordFetch[]
    } = {}
) {
    let stored = opts.stored ?? null
    let indexedRev = opts.indexedRev ?? null
    let epoch = opts.epoch ?? 1
    const calls: string[] = []
    const owedRevs: string[] = []
    const deps: SecondaryDeps = {
        index: {
            dueSecondaries: async () => opts.owed ?? [OWED],
            deferSecondary: async () => {
                calls.push("defer")
                return 1
            },
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
                throw new RecordNotFoundError("no record", false, "RecordNotFound")
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
                owedGenOf: async () => 1,
                isDeleted: async () => false,
                isWatched: async () => true,
            } as unknown as MonitorIndex,
            snapshot: { deleteRecord: async () => {}, getRecord: async () => null } as unknown as SnapshotStore,
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
        const record = declarationDeps(new RecordNotFoundError("no record", false, "RecordNotFound"))
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
        expect(absent.clearPending).toHaveBeenCalledWith(DID, 1)
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

describe("settleSecondaryDue when a settle fails", () => {
    const SECOND: PendingRecordFetch = { ...OWED, did: "did:plc:bob", attempts: 3 }
    const boom = async () => {
        throw new TypeError("pds down")
    }

    /** `fetch` throws for the first DID only; every deferral is recorded. */
    function failing(extra: Partial<SecondaryDeps> = {}, owed = [OWED, SECOND]) {
        const h = harness({ owed })
        const deferred: { ref: RecordRef; notBeforeMs: number; failure: unknown }[] = []
        const events: SecondarySettleFailureEvent[] = []
        h.deps.fetchRecord = async (ref) => {
            if (ref.did === OWED.did) return boom()
            return { car: new Uint8Array([9]), source: "https://pds", signingKey: KEY }
        }
        h.deps.index.deferSecondary = async (ref, notBeforeMs, failure) => {
            deferred.push({ ref, notBeforeMs, failure })
            return (ref as PendingRecordFetch).attempts + 1
        }
        h.deps.onSettleFailure = (event) => void events.push(event)
        Object.assign(h.deps, extra)
        return { ...h, deferred, events }
    }

    it("keeps the failure on the row and reports it once through onSettleFailure, with the record named", async () => {
        const h = failing({}, [OWED])
        const stored = h.deps.index.deferSecondary
        h.deps.index.deferSecondary = async (ref, notBeforeMs, failure) => {
            await stored(ref, notBeforeMs, failure)
            return 7
        }
        expect(await settleSecondaryDue(h.deps)).toBe(0)
        const failure = { kind: "threw", errorName: "TypeError", message: "pds down", atMs: 1_000 }
        expect(h.deferred).toEqual([{ ref: OWED, notBeforeMs: 2_000, failure }])
        expect(h.events).toEqual([
            {
                did: DID,
                collection: COLLECTION,
                rkey: "self",
                attempts: 7,
                failure,
                notBeforeMs: 2_000,
            },
        ])
    })

    it("truncates a long message to the pending-row limit", async () => {
        const h = failing({ fetchRecord: async () => { throw new Error("x".repeat(1_000)) } }, [OWED])
        await settleSecondaryDue(h.deps)
        expect(h.events[0]!.failure).toMatchObject({ kind: "threw" })
        expect((h.events[0]!.failure as { message: string }).message).toHaveLength(
            PENDING_FAILURE_MESSAGE_MAX
        )
    })

    it("backs off 2^attempts seconds, capped at the DID's retryCapMs, else SETTLE_RETRY_CAP_MS", async () => {
        const fifth = { ...OWED, attempts: 5 }
        const uncapped = failing({}, [fifth])
        await settleSecondaryDue(uncapped.deps)
        expect(uncapped.deferred[0]!.notBeforeMs).toBe(1_000 + 32_000)

        const capped = failing({ retryCapMs: async () => 10_000 }, [fifth])
        await settleSecondaryDue(capped.deps)
        expect(capped.deferred[0]!.notBeforeMs).toBe(1_000 + 10_000)

        const huge = failing({}, [{ ...OWED, attempts: 60 }])
        await settleSecondaryDue(huge.deps)
        expect(huge.deferred[0]!.notBeforeMs).toBe(1_000 + SETTLE_RETRY_CAP_MS)
    })

    it("settles the rest of the batch after one record throws", async () => {
        const h = failing()
        expect(await settleSecondaryDue(h.deps)).toBe(1)
        expect(h.deferred.map((d) => d.ref.did)).toEqual([DID])
        expect(h.calls).toContain("complete")
    })

    it("settles the rest of the batch when recording a failure itself throws", async () => {
        const h = failing()
        h.deps.index.deferSecondary = async () => {
            throw new Error("storage down")
        }
        expect(await settleSecondaryDue(h.deps)).toBe(1)
        expect(h.events).toEqual([])

        const cap = failing({
            retryCapMs: async () => {
                throw new Error("cap lookup down")
            },
        })
        expect(await settleSecondaryDue(cap.deps)).toBe(1)
    })

    it("reports nothing for a row already gone (deferSecondary answers null)", async () => {
        const h = failing()
        h.deps.index.deferSecondary = async () => null
        expect(await settleSecondaryDue(h.deps)).toBe(1)
        expect(h.events).toEqual([])
    })

    it("a throwing onSettleFailure costs neither the deferral nor the rest of the batch", async () => {
        const h = failing({
            onSettleFailure: () => {
                throw new Error("hook broke")
            },
        })
        expect(await settleSecondaryDue(h.deps)).toBe(1)
        expect(h.deferred).toHaveLength(1)
    })
})
