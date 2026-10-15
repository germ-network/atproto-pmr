/**
 * `refreshDue`: keeps every held snapshot confirmed current, without
 * treating unrelated repo commits as declaration changes.
 */
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError, verifyRecordProofOutcome } from "@germ-network/atproto-pmr-core"
import { buildRepoCar, type TestKey, makeKey } from "../../core/test/fixtures/repo-car"
import type { IngestDeps, FetchedRecord, VerifyOutcome } from "../src/ingest"
import { refreshDue, type RefreshDeps, type SnapshotCheck } from "../src/refresh"
import type { SecondaryDeps } from "../src/secondary"
import {
    FETCH_AS_OF_SKEW_MS,
    type IndexedRecord,
    type MonitorIndex,
    type SnapshotEntry,
    type SnapshotStore,
} from "../src/storage"

const COLLECTION = "com.germnetwork.declaration"
const RKEY = "self"
const PATH = `${COLLECTION}/${RKEY}`
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const NOW = 10_000_000
const STALE = 3_600_000
const NON_HOLDER_STALE = 86_400_000
const PROFILE = "app.bsky.actor.profile"

const key: TestKey = makeKey()

function car(rev: string, record: unknown, extra: Record<string, unknown> = {}, signWith = key) {
    return buildRepoCar({
        did: DID,
        key: signWith,
        rev,
        records: { ...(record === null ? {} : { [PATH]: record }), ...extra },
    })
}
const headAt = (rev: string, signingKey: string | null = key.multikey) => ({ rev, signingKey })
const decl = (n: number) => ({ $type: COLLECTION, version: "1.1.0", n })

function fetched(
    rev: string,
    record: unknown,
    signWith: TestKey = key,
    extra = {}
): FetchedRecord & { rev: string } {
    return {
        rev,
        car: car(rev, record, extra, signWith).car,
        source: PDS,
        signingKey: signWith.multikey,
    }
}

function harness(opts: {
    indexed?: Record<string, string>
    stored?: Record<string, FetchedRecord & { rev: string }>
    head?: (did: string) => Promise<{ rev: string; signingKey: string | null }>
    /** DIDs the index already holds as reversibly gone. */
    gone?: string[]
    /** DIDs whose stored snapshot predates verification: no records row, no verifiedWith. */
    legacy?: string[]
    fetchRecord?: (did: string) => Promise<FetchedRecord>
    due?: string[]
    /** The profile already indexed for DID, at this rev and under this key. */
    profile?: { rev: string; cid?: string; verifiedWith?: string }
    profileFetch?: () => Promise<FetchedRecord>
    profileVerify?: (record: FetchedRecord) => Promise<VerifyOutcome>
    watchProfile?: boolean
}) {
    const revs = new Map(Object.entries(opts.indexed ?? {}))
    const records = new Map<string, SnapshotEntry>(
        Object.entries(opts.stored ?? {}).map(([did, r]) => [
            did,
            {
                ...r,
                observedAtMs: 1,
                verifiedWith: (opts.legacy ?? []).includes(did) ? null : r.signingKey,
                cid: "bafyreistored",
            },
        ])
    )
    const checks = new Map<string, SnapshotCheck>()
    const checkedAt = new Map<string, number>()
    const attempted = new Map<string, number>()
    const windows: string[] = []
    const quiet: string[] = []
    const quietVerified: Array<{ cid: string; verifiedWith: string }> = []
    const goneReversible: string[] = []
    const deleted = new Set<string>()
    const onChange = vi.fn(async () => {})
    const onRegression = vi.fn(async () => {})
    const onDelete = vi.fn(async () => {})
    const dueCalls: Array<{ before: number; limit: number }> = []

    const profileRows = new Map<string, IndexedRecord>()
    if (opts.profile !== undefined) {
        profileRows.set(DID, {
            did: DID,
            collection: PROFILE,
            rkey: RKEY,
            rev: opts.profile.rev,
            cid: opts.profile.cid ?? "bafyreiprofile",
            verifiedWith: opts.profile.verifiedWith ?? key.multikey,
        })
    }
    const profileChecks: Array<{ rev: string; checkedAtMs: number }> = []
    const profileStored: SnapshotEntry[] = []
    const disposed: string[] = []
    const deferred: string[] = []
    const index = {
        revOf: async (did: string) => revs.get(did) ?? null,
        complete: async (did: string, rev: string) => {
            revs.set(did, rev)
            windows.push(did)
        },
        completeDeletion: async (did: string, _at: number, permanent: boolean) => {
            windows.push(did)
            if (permanent) deleted.add(did)
            revs.delete(did)
        },
        clearPending: async () => {},
        markAttempted: async (did: string, at: number) => void attempted.set(did, at),
        isWatched: async (did: string) => revs.has(did) && !deleted.has(did),
        holderStateOf: async (did: string) =>
            (opts.gone ?? []).includes(did) ? "gone-reversible" : revs.has(did) ? "held" : null,
        recordsOf: async (did: string) => {
            const e = records.get(did)
            const extra = [...profileRows.values()].filter((r) => r.did === did)
            if (e === undefined || e.verifiedWith === null) return extra
            return [
                ...extra,
                {
                    did,
                    collection: COLLECTION,
                    rkey: RKEY,
                    rev: e.rev,
                    cid: e.cid ?? "bafyreistored",
                    verifiedWith: e.verifiedWith,
                },
            ]
        },
        isDeleted: async (did: string) => deleted.has(did),
    } as unknown as MonitorIndex
    const snapshot = {
        getRecord: async (did: string) => records.get(did) ?? null,
        putRecord: async (did: string, e: SnapshotEntry) => void records.set(did, e),
        deleteRecord: async (did: string) => {
            records.delete(did)
            checks.delete(did)
        },
    } as unknown as SnapshotStore
    const ingest: IngestDeps = {
        index,
        snapshot,
        fetchRecord: opts.fetchRecord ?? (async () => fetched("3m2", decl(1))),
        verify: async (did, record) => {
            if (record.signingKey === null) return { kind: "unverifiable" }
            try {
                const out = verifyRecordProofOutcome(record.car, {
                    did,
                    signingKey: record.signingKey,
                    collection: COLLECTION,
                    rkey: RKEY,
                })
                return out.kind === "present"
                    ? { kind: "verified", key: record.signingKey, rev: out.rev, cid: out.cid }
                    : { kind: "verified-absent", key: record.signingKey, rev: out.rev }
            } catch {
                return { kind: "unverifiable" }
            }
        },
        onChange,
        onRegression,
        onDelete,
        interest: { inInterest: async () => true, interestEpoch: async () => 0 },
        secondaries: { dispose: async (did: string) => void disposed.push(did) },
        nowMs: () => NOW,
    }
    const secondary: SecondaryDeps = {
        index: {
            dueSecondaries: async () => [],
            deferSecondary: async () => {},
            clearSecondary: async () => {},
            completeSecondary: async (ref, rev, verified) => {
                profileRows.set(ref.did, {
                    did: ref.did,
                    collection: ref.collection,
                    rkey: ref.rkey,
                    rev,
                    cid: verified.cid,
                    verifiedWith: verified.verifiedWith,
                })
                return "stored"
            },
            disposeSecondary: async (ref) => {
                profileRows.delete(ref.did)
                return "disposed"
            },
            secondaryRevOf: async (ref) => profileRows.get(ref.did)?.rev ?? null,
            forgetSecondaries: async () => {},
        },
        interest: ingest.interest,
        snapshot: {
            getSecondary: async () => null,
            putSecondary: async (_r, e) => void profileStored.push(e),
            deleteSecondary: async () => {},
            putSecondaryCheck: async (_r, c) => void profileChecks.push(c),
        },
        fetchRecord: opts.profileFetch ?? (async () => fetched("3m2", decl(1))),
        verify: async (_ref, record) =>
            opts.profileVerify !== undefined
                ? opts.profileVerify(record)
                : { kind: "verified", key: key.multikey, rev: "3m2", cid: "bafyreiprofile2" },
        deferToDeclaration: async (did) => void deferred.push(did),
        nowMs: () => NOW,
    }
    const deps: RefreshDeps = {
        ingest,
        refreshIndex: {
            dueRefresh: async (before, limit, _nonHolderBefore) => {
                dueCalls.push({ before, limit })
                return (opts.due ?? Object.keys(opts.indexed ?? {}))
                    .filter((did) => (attempted.get(did) ?? 0) < before)
                    .slice(0, limit)
            },
            markChecked: async (did, at) => void checkedAt.set(did, at),
            markAttempted: async (did, at) => void attempted.set(did, at),
            markGoneReversible: async (did) => void goneReversible.push(did),
            completeQuietly: async (did, rev, _at, verified) => {
                revs.set(did, rev)
                quiet.push(did)
                quietVerified.push(verified)
            },
        },
        refreshSnapshots: { putCheck: async (did, c) => void checks.set(did, c) },
        fetchHeadRev: opts.head ?? (async () => headAt("3m1")),
        collection: COLLECTION,
        rkey: RKEY,
        secondary: {
            deps: secondary,
            records: opts.watchProfile === true ? [{ collection: PROFILE, rkey: RKEY }] : [],
        },
    }
    return { profileRows, profileChecks, profileStored, disposed, deferred, deps, quietVerified, goneReversible, attempted, revs, records, checks, checkedAt, windows, quiet, deleted, onChange, onRegression, onDelete, dueCalls }
}

const run = (h: ReturnType<typeof harness>, limit = 64) =>
    refreshDue(h.deps, {
        nowMs: NOW,
        staleAfterMs: STALE,
        limit,
        nonHolderStaleAfterMs: NON_HOLDER_STALE,
    })

describe("refreshDue", () => {
    it("an unchanged head rev writes a check at that rev and touches neither the CAR nor the digest window", async () => {
        const stored = fetched("3m1", decl(1))
        const h = harness({ indexed: { [DID]: "3m1" }, stored: { [DID]: stored } })
        const result = await run(h)
        expect(result.outcomes.confirmed).toBe(1)
        expect(h.checks.get(DID)).toEqual({ rev: "3m1", checkedAtMs: NOW })
        expect(h.checkedAt.get(DID)).toBe(NOW)
        expect(h.records.get(DID)!.car).toBe(stored.car)
        expect(h.windows).toEqual([])
        expect(h.dueCalls).toEqual([{ before: NOW - STALE, limit: 64 }])
    })

    it("an advanced rev with the same declaration record CID stores the new CAR quietly: no window entry, no onChange", async () => {
        const stored = fetched("3m1", decl(1))
        const next = fetched("3m2", decl(1), key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } })
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: stored },
            head: async () => headAt("3m2"),
            fetchRecord: async () => next,
        })
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.records.get(DID)!.car).toBe(next.car)
        expect(h.records.get(DID)!.rev).toBe("3m2")
        expect(h.revs.get(DID)).toBe("3m2")
        expect(h.quiet).toEqual([DID])
        expect(h.quietVerified).toEqual([
            { cid: expect.stringMatching(/^bafyrei/), verifiedWith: key.multikey },
        ])
        expect(h.checks.get(DID)).toEqual({ rev: "3m2", checkedAtMs: NOW })
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
    })

    it("an advanced rev with a different record CID takes the full settle path (window entry and onChange)", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", decl(2)),
        })
        const result = await run(h)
        expect(result.outcomes.changed).toBe(1)
        expect(h.windows).toEqual([DID])
        expect(h.onChange).toHaveBeenCalledWith(DID, "3m2")
        expect(h.quiet).toEqual([])
    })

    it("a regressed head rev raises onRegression and stores nothing", async () => {
        const stored = fetched("3m5", decl(1))
        const h = harness({
            indexed: { [DID]: "3m5" },
            stored: { [DID]: stored },
            head: async () => headAt("3m1"),
        })
        const result = await run(h)
        expect(result.outcomes.regressed).toBe(1)
        expect(h.onRegression).toHaveBeenCalledWith(DID, "3m5", "3m1")
        expect(h.records.get(DID)).toMatchObject({ rev: "3m5" })
        // Not re-confirmed at the relay, but not re-raised on the next pass either.
        expect(h.checks.size).toBe(0)
        expect(h.checkedAt.get(DID)).toBe(NOW)
    })

    it("a terminal Repo* error from the head-rev read deletes rec: and chk: through settle's deletion branch", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => {
                throw new RecordNotFoundError("deactivated", true)
            },
        })
        h.checks.set(DID, { rev: "3m1", checkedAtMs: 1 })
        const result = await run(h)
        expect(result.outcomes.deleted).toBe(1)
        expect(h.records.has(DID)).toBe(false)
        expect(h.checks.has(DID)).toBe(false)
        expect(h.deleted.has(DID)).toBe(true)
        expect(h.windows).toEqual([DID])
        expect(h.onDelete).toHaveBeenCalledWith(DID)
    })

    it("an advanced rev whose CAR proves no record at the path is a non-permanent deletion", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", null, key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }),
        })
        const result = await run(h)
        expect(result.outcomes.deleted).toBe(1)
        expect(h.records.has(DID)).toBe(false)
        expect(h.deleted.has(DID)).toBe(false)
        expect(h.windows).toEqual([DID])
    })

    it("a reversible deletion already applied is re-confirmed without another window entry or push", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            head: async () => {
                throw new RecordNotFoundError("deactivated", false)
            },
        })
        const result = await run(h)
        expect(result.outcomes.confirmed).toBe(1)
        expect(h.windows).toEqual([])
        expect(h.onDelete).not.toHaveBeenCalled()
        expect(h.goneReversible).toEqual([DID])
        expect(h.checkedAt.get(DID)).toBe(NOW)
    })

    it("a reversible deletion that later hardens to permanent is recorded as deleted", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            head: async () => {
                throw new RecordNotFoundError("gone", true)
            },
        })
        const result = await run(h)
        expect(result.outcomes.deleted).toBe(1)
        expect(h.deleted.has(DID)).toBe(true)
        expect(h.onDelete).toHaveBeenCalledTimes(1)
    })

    it("a re-keyed DID document with the same record CID goes through settle so a registered device is told", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", decl(1), makeKey()),
        })
        const result = await run(h)
        expect(result.outcomes.changed).toBe(1)
        expect(h.quiet).toEqual([])
    })

    it("a transient fetch failure writes no check and marks the DID attempted", async () => {
        const down = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => {
                throw new Error("pds down")
            },
        })
        expect((await run(down)).outcomes.failed).toBe(1)
        expect(down.checks.size).toBe(0)
        expect(down.checkedAt.size).toBe(0)
        expect(down.attempted.get(DID)).toBe(NOW)
        expect(down.records.has(DID)).toBe(true)

        const half = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => {
                throw new Error("pds down")
            },
        })
        expect((await run(half)).outcomes.failed).toBe(1)
        expect(half.checks.size).toBe(0)
    })

    it("processes at most limit DIDs, least recently checked first", async () => {
        const dids = ["did:plc:a", "did:plc:b", "did:plc:c"]
        const h = harness({
            indexed: Object.fromEntries(dids.map((d) => [d, "3m1"])),
            stored: Object.fromEntries(dids.map((d) => [d, fetched("3m1", decl(1))])),
            due: dids,
        })
        const result = await run(h, 2)
        expect(result.checked).toBe(2)
        expect([...h.checks.keys()]).toEqual(["did:plc:a", "did:plc:b"])
        expect(h.dueCalls[0]!.limit).toBe(2)
    })
})

describe("refresh keeps the stored DID document", () => {
    it("a quiet advance records the fetched record's document", async () => {
        const document = { id: DID }
        const recordDidDocument = vi.fn(async () => {})
        const next = {
            ...fetched("3m2", decl(1), key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }),
            didDocument: { document, fetchedAtMs: 123_456 },
        }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => next,
        })
        h.deps.ingest.didDocuments = { recordDidDocument, markDidDocumentStale: async () => {} }
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(recordDidDocument).toHaveBeenCalledExactlyOnceWith(DID, document, 123_456 - FETCH_AS_OF_SKEW_MS)
    })

    it("a fetch that finds the record gone still records the document", async () => {
        const document = { id: DID }
        const recordDidDocument = vi.fn(async () => {})
        const gone = {
            ...fetched("3m2", null),
            didDocument: { document, fetchedAtMs: 50_000 },
        }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => gone,
        })
        h.deps.ingest.didDocuments = { recordDidDocument, markDidDocumentStale: async () => {} }
        await run(h)
        expect(recordDidDocument).toHaveBeenCalledWith(DID, document, 50_000 - FETCH_AS_OF_SKEW_MS)
    })

    it("a changed record's document is recorded even when the settle's own fetch fails", async () => {
        const document = { id: DID }
        const recordDidDocument = vi.fn(async () => {})
        let calls = 0
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => {
                if (++calls > 1) throw new Error("pds down")
                return { ...fetched("3m2", decl(2)), didDocument: { document, fetchedAtMs: 9_000 } }
            },
        })
        h.deps.ingest.didDocuments = { recordDidDocument, markDidDocumentStale: async () => {} }
        await run(h).catch(() => {})
        expect(recordDidDocument).toHaveBeenCalledWith(DID, document, 9_000 - FETCH_AS_OF_SKEW_MS)
    })

    it("a failing document write does not fail the quiet advance", async () => {
        const next = {
            ...fetched("3m2", decl(1), key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }),
            didDocument: { document: { id: DID }, fetchedAtMs: 1 },
        }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => next,
        })
        h.deps.ingest.didDocuments = {
            recordDidDocument: async () => {
                throw new Error("store down")
            },
            markDidDocumentStale: async () => {},
        }
        expect((await run(h)).outcomes["advanced-quiet"]).toBe(1)
    })

    // A document stored for a DID that stays unwatched would be trusted for a
    // day with nothing following it.
    it("a re-fetch that leaves the DID unwatched withdraws the document it stored", async () => {
        const document = { id: DID }
        const recordDidDocument = vi.fn(async () => {})
        const markDidDocumentStale = vi.fn(async () => {})
        const gone = { ...fetched("3m2", null, key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }), didDocument: { document, fetchedAtMs: 50_000 } }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => gone,
        })
        h.deps.ingest.didDocuments = { recordDidDocument, markDidDocumentStale }
        // Holds until the verified-absent disposal ends it, as in the object.
        let ended = false
        const completeDeletion = h.deps.ingest.index.completeDeletion
        h.deps.ingest.index.completeDeletion = async (...args) => {
            ended = true
            return completeDeletion(...args)
        }
        h.deps.ingest.index.isWatched = async () => !ended
        await run(h)
        expect(recordDidDocument).toHaveBeenCalledExactlyOnceWith(DID, document, 50_000 - FETCH_AS_OF_SKEW_MS)
        expect(markDidDocumentStale).toHaveBeenCalledExactlyOnceWith(DID, 50_000 - FETCH_AS_OF_SKEW_MS)
    })

    // No row, no version bump and no KV delete on each head move of a DID
    // that was never watched.
    it("a re-fetch for a DID that was not watched records nothing and withdraws nothing", async () => {
        const recordDidDocument = vi.fn(async () => {})
        const markDidDocumentStale = vi.fn(async () => {})
        const gone = { ...fetched("3m2", null, key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }), didDocument: { document: { id: DID }, fetchedAtMs: 50_000 } }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => gone,
            gone: [DID],
        })
        h.deps.ingest.didDocuments = { recordDidDocument, markDidDocumentStale }
        h.deps.ingest.index.isWatched = async () => false
        await run(h)
        expect(recordDidDocument).not.toHaveBeenCalled()
        expect(markDidDocumentStale).not.toHaveBeenCalled()
    })

    it("a failing sink leaves nothing to withdraw", async () => {
        const markDidDocumentStale = vi.fn(async () => {})
        const gone = { ...fetched("3m2", null, key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }), didDocument: { document: { id: DID }, fetchedAtMs: 50_000 } }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => gone,
        })
        h.deps.ingest.didDocuments = {
            recordDidDocument: async () => {
                throw new Error("store down")
            },
            markDidDocumentStale,
        }
        await run(h)
        expect(markDidDocumentStale).not.toHaveBeenCalled()
    })

    it("a failing isWatched after the outcome is not taken for unwatched", async () => {
        const markDidDocumentStale = vi.fn(async () => {})
        const gone = { ...fetched("3m2", null, key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }), didDocument: { document: { id: DID }, fetchedAtMs: 50_000 } }
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => gone,
        })
        h.deps.ingest.didDocuments = { recordDidDocument: async () => {}, markDidDocumentStale }
        let calls = 0
        h.deps.ingest.index.isWatched = async () => {
            if (++calls > 1) throw new Error("index down")
            return true
        }
        await run(h)
        expect(markDidDocumentStale).not.toHaveBeenCalled()
    })
})

describe("refresh re-verifies", () => {
    const olderCar = (signWith = key) =>
        fetched("3m1", decl(1), signWith, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } })

    it("unchanged head with no records row re-fetches and verifies quietly", async () => {
        const stored = fetched("3m1", decl(1))
        const fetchRecord = vi.fn(async () => stored)
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: stored },
            legacy: [DID],
            fetchRecord,
        })
        const result = await run(h)
        expect(fetchRecord).toHaveBeenCalledTimes(1)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.quietVerified).toEqual([
            { cid: expect.stringMatching(/^bafyrei/), verifiedWith: key.multikey },
        ])
        expect(h.records.get(DID)).toMatchObject({ verifiedWith: key.multikey })
    })

    it("unchanged head with an entry verified under a rotated key re-fetches", async () => {
        const rotated = makeKey()
        const fetchRecord = vi.fn(async () => fetched("3m1", decl(1), rotated))
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m1", rotated.multikey),
            fetchRecord,
        })
        const result = await run(h)
        expect(fetchRecord).toHaveBeenCalled()
        expect(result.outcomes.changed).toBe(1)
        expect(h.onChange).toHaveBeenCalledWith(DID, "3m1")
    })

    it("an unchanged head under an unchanged key is only confirmed", async () => {
        const fetchRecord = vi.fn(async () => fetched("3m1", decl(1)))
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            fetchRecord,
        })
        expect((await run(h)).outcomes.confirmed).toBe(1)
        expect(fetchRecord).not.toHaveBeenCalled()
    })

    it("a document with no key is a mismatch and takes the fetch path", async () => {
        const fetchRecord = vi.fn(async () => fetched("3m1", decl(1)))
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m1", null),
            fetchRecord,
        })
        await run(h)
        expect(fetchRecord).toHaveBeenCalledTimes(1)
    })

    it("a declaration already reversibly gone is not re-fetched on an unchanged head", async () => {
        const fetchRecord = vi.fn(async () => fetched("3m1", decl(1)))
        const h = harness({ indexed: { [DID]: "3m1" }, gone: [DID], fetchRecord })
        expect((await run(h)).outcomes.confirmed).toBe(1)
        expect(fetchRecord).not.toHaveBeenCalled()
    })

    it("a fetched CAR older than the indexed rev is not stored quietly, even with the same record CID", async () => {
        const h = harness({
            indexed: { [DID]: "3m5" },
            stored: { [DID]: fetched("3m5", decl(1)) },
            head: async () => headAt("3m6"),
            fetchRecord: async () => fetched("3m4", decl(1)),
        })
        await run(h)
        expect(h.quiet).toEqual([])
        expect(h.onRegression).toHaveBeenCalledWith(DID, "3m5", "3m4")
    })

    it("an exclusion proof that does not verify does not dispose the snapshot", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () =>
                fetched("3m2", null, makeKey(), { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } }),
        })
        h.deps.ingest.verify = async () => ({ kind: "unverifiable" })
        const result = await run(h)
        expect(result.outcomes.deleted).toBe(0)
        expect(h.records.has(DID)).toBe(true)
        expect(h.windows).toEqual([])
        expect(h.attempted.get(DID)).toBe(NOW)
    })

    it("quiet advance verifies and stays quiet", async () => {
        const verify = vi.fn(async () => ({
            kind: "verified" as const,
            key: key.multikey,
            rev: "3m2",
            cid: "bafyreistored",
        }))
        const next = fetched("3m2", decl(1), key, { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } })
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m2"),
            fetchRecord: async () => next,
        })
        h.deps.ingest.verify = verify
        const result = await run(h)
        expect(verify).toHaveBeenCalledTimes(1)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
    })

    it("a DID attempted this interval is not retried until the next", async () => {
        const fetchRecord = vi.fn(async () => olderCar(makeKey()))
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            legacy: [DID],
            fetchRecord,
        })
        h.deps.ingest.verify = async () => ({ kind: "unverifiable" })
        await run(h)
        expect(fetchRecord).toHaveBeenCalledTimes(1)

        expect((await run(h)).checked).toBe(0)
        expect(fetchRecord).toHaveBeenCalledTimes(1)

        const later = await refreshDue(h.deps, { nowMs: NOW + STALE + 1, staleAfterMs: STALE, limit: 64, nonHolderStaleAfterMs: NON_HOLDER_STALE })
        expect(later.checked).toBe(1)
        expect(fetchRecord).toHaveBeenCalledTimes(2)
    })

    it("the first pass after upgrade puts no legacy DID in the digest window", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            legacy: [DID],
            fetchRecord: async () => fetched("3m1", decl(1)),
        })
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
    })
})

describe("refresh pushes a re-key", () => {
    // A re-key whose record does not verify under the new key is still told
    // to the device, once per key, as settle does.
    function rekeyed() {
        const other = makeKey()
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => headAt("3m1", other.multikey),
            fetchRecord: async () => fetched("3m1", decl(1), other),
        })
        h.deps.ingest.verify = async () => ({ kind: "unverifiable" })
        return { h, other }
    }

    it("an unverifiable re-key found by refresh pushes onChange once", async () => {
        const { h, other } = rekeyed()
        const result = await run(h)
        expect(result.outcomes.failed).toBe(1)
        expect(h.onChange).toHaveBeenCalledTimes(1)
        expect(h.onChange).toHaveBeenCalledWith(DID, "3m1")
        expect(h.records.get(DID)!.seenKey).toBe(other.multikey)
        expect(h.records.get(DID)!.verifiedWith).toBe(key.multikey)
    })

    it("an unverifiable re-key found by refresh: a second refresh under the same seen key does not push again", async () => {
        const { h } = rekeyed()
        await run(h)
        const second = await refreshDue(h.deps, {
            nowMs: NOW + STALE + 1,
            staleAfterMs: STALE,
            limit: 64,
            nonHolderStaleAfterMs: NON_HOLDER_STALE,
        })
        expect(second.outcomes.failed).toBe(1)
        expect(h.onChange).toHaveBeenCalledTimes(1)
    })
})

describe("one head check covers every record", () => {
    // One getLatestCommit per DID confirms or re-fetches the declaration and
    // every secondary; a secondary never moves revs or enters the window.
    const hp = (o: Parameters<typeof harness>[0]) => harness({ ...o, watchProfile: true })
    const profileAt = (rev: string, cid = "bafyreiprofile") => ({ rev, cid })
    const profileVerifyAt = (rev: string, cid: string) => async (): Promise<VerifyOutcome> => ({
        kind: "verified",
        key: key.multikey,
        rev,
        cid,
    })
    const held = (rev: string) => ({ indexed: { [DID]: rev }, stored: { [DID]: fetched(rev, decl(1)) } })

    it("unchanged head confirms declaration and profile", async () => {
        const profileFetch = vi.fn(async () => fetched("3m1", decl(1)))
        const h = hp({ ...held("3m1"), profile: profileAt("3m1"), profileFetch })
        const result = await run(h)
        expect(result.outcomes.confirmed).toBe(1)
        expect(h.checks.get(DID)).toEqual({ rev: "3m1", checkedAtMs: NOW })
        expect(h.profileChecks).toEqual([{ rev: "3m1", checkedAtMs: NOW }])
        expect(profileFetch).not.toHaveBeenCalled()
        expect(h.profileStored).toEqual([])
    })

    it("moved head with unchanged profile CID stores it quietly at the signed rev", async () => {
        const h = hp({
            ...held("3m1"),
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", decl(1)),
            profile: profileAt("3m1", "bafyreisame"),
            profileVerify: profileVerifyAt("3m2", "bafyreisame"),
        })
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.profileStored).toHaveLength(1)
        expect(h.profileStored[0]).toMatchObject({ rev: "3m2", cid: "bafyreisame" })
        expect(h.profileRows.get(DID)).toMatchObject({ rev: "3m2", cid: "bafyreisame" })
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
    })

    it("moved head with changed profile CID settles the profile only", async () => {
        const h = hp({
            ...held("3m1"),
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", decl(1)),
            profile: profileAt("3m1", "bafyreiold"),
            profileVerify: profileVerifyAt("3m2", "bafyreinew"),
        })
        await run(h)
        expect(h.profileRows.get(DID)).toMatchObject({ rev: "3m2", cid: "bafyreinew" })
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
        expect(h.onDelete).not.toHaveBeenCalled()
        expect(h.deleted.size).toBe(0)
    })

    it("missing profile is fetched on the next check", async () => {
        const h = hp({
            ...held("3m1"),
            profileVerify: profileVerifyAt("3m1", "bafyreinew"),
        })
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.profileStored).toHaveLength(1)
        expect(h.profileRows.get(DID)).toMatchObject({ rev: "3m1" })
        expect(h.checks.get(DID)).toEqual({ rev: "3m1", checkedAtMs: NOW })
    })

    it("a profile commit does not lapse the declaration's chk:", async () => {
        const h = hp({
            ...held("3m1"),
            head: async () => headAt("3m2"),
            fetchRecord: async () => fetched("3m2", decl(1)),
            profile: profileAt("3m1"),
            profileVerify: profileVerifyAt("3m2", "bafyreinew"),
        })
        await run(h)
        expect(h.checks.get(DID)).toEqual({ rev: "3m2", checkedAtMs: NOW })
        expect(h.records.get(DID)!.rev).toBe("3m2")
    })

    it("a non-holder's head check does not fetch the declaration", async () => {
        const fetchRecord = vi.fn(async () => fetched("3m1", decl(1)))
        const h = hp({
            due: [DID],
            head: async () => headAt("3m1"),
            fetchRecord,
            profileVerify: profileVerifyAt("3m1", "bafyreinew"),
        })
        const result = await run(h)
        expect(fetchRecord).not.toHaveBeenCalled()
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.profileRows.get(DID)).toMatchObject({ rev: "3m1" })
        expect(h.checkedAt.get(DID)).toBe(NOW)
        expect(h.records.has(DID)).toBe(false)
    })

    it("a record-level not-found for a non-holder does not mark it deleted", async () => {
        const h = hp({
            due: [DID],
            head: async () => headAt("3m1"),
            profileFetch: async () => {
                throw new RecordNotFoundError("no record", true, "RecordNotFound")
            },
        })
        const result = await run(h)
        expect(result.outcomes.failed).toBe(1)
        expect(h.deleted.size).toBe(0)
        expect(h.goneReversible).toEqual([])
        expect(h.attempted.get(DID)).toBe(NOW)
        expect(h.windows).toEqual([])
    })

    it("a repo-level answer at a non-holder's head check disposes its profile with no window entry or onDelete", async () => {
        const h = hp({
            due: [DID],
            head: async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            },
        })
        const result = await run(h)
        expect(result.outcomes.deleted).toBe(1)
        expect(h.disposed).toEqual([DID])
        expect(h.windows).toEqual([])
        expect(h.onDelete).not.toHaveBeenCalled()
        expect(h.deleted.size).toBe(0)
        // No holder state, so it keeps the daily cadence.
        expect(h.goneReversible).toEqual([])
        expect(h.checkedAt.get(DID)).toBe(NOW)
    })

    it("a secondary under a non-current key is fetched again at an unchanged head", async () => {
        const profileFetch = vi.fn(async () => fetched("3m1", decl(1)))
        const h = hp({
            ...held("3m1"),
            profile: { rev: "3m1", verifiedWith: "zOldKey" },
            profileFetch,
            profileVerify: profileVerifyAt("3m1", "bafyreinew"),
        })
        await run(h)
        expect(profileFetch).toHaveBeenCalledTimes(1)
        expect(h.profileRows.get(DID)).toMatchObject({ verifiedWith: key.multikey })
    })

    it("a record-level absence of the declaration keeps the profile; a repo-level one disposes it without fetching it again", async () => {
        const recordLevel = hp({
            ...held("3m1"),
            head: async () => headAt("3m2"),
            fetchRecord: async () => {
                throw new RecordNotFoundError("no record", true, "RecordNotFound")
            },
            profile: profileAt("3m1"),
        })
        await run(recordLevel)
        expect(recordLevel.disposed).toEqual([])
        expect(recordLevel.profileRows.has(DID)).toBe(true)

        const profileFetch = vi.fn(async () => fetched("3m2", decl(1)))
        const repoLevel = hp({
            ...held("3m1"),
            head: async () => headAt("3m2"),
            fetchRecord: async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            },
            profile: profileAt("3m1"),
            profileFetch,
        })
        await run(repoLevel)
        expect(repoLevel.disposed).toEqual([DID])
        expect(profileFetch).not.toHaveBeenCalled()
    })

    it("a repo-level answer at a held DID's head check disposes its profile too", async () => {
        const h = hp({
            ...held("3m1"),
            head: async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            },
        })
        await run(h)
        expect(h.disposed).toEqual([DID])
        expect(h.onDelete).toHaveBeenCalledWith(DID)
    })
})
