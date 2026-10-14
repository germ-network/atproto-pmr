/**
 * `refreshDue`: keeps every held snapshot confirmed current, without
 * treating unrelated repo commits as declaration changes.
 */
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError, verifyRecordProofOutcome } from "@germ-network/atproto-pmr-core"
import { buildRepoCar, type TestKey, makeKey } from "../../core/test/fixtures/repo-car"
import type { IngestDeps, FetchedRecord } from "../src/ingest"
import { refreshDue, type RefreshDeps, type SnapshotCheck } from "../src/refresh"
import { FETCH_AS_OF_SKEW_MS, type MonitorIndex, type SnapshotEntry, type SnapshotStore } from "../src/storage"

const COLLECTION = "com.germnetwork.declaration"
const RKEY = "self"
const PATH = `${COLLECTION}/${RKEY}`
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const NOW = 10_000_000
const STALE = 3_600_000

const key: TestKey = makeKey()

function car(rev: string, record: unknown, extra: Record<string, unknown> = {}, signWith = key) {
    return buildRepoCar({
        did: DID,
        key: signWith,
        rev,
        records: { ...(record === null ? {} : { [PATH]: record }), ...extra },
    })
}
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
    head?: (did: string) => Promise<string>
    fetchRecord?: (did: string) => Promise<FetchedRecord>
    due?: string[]
}) {
    const revs = new Map(Object.entries(opts.indexed ?? {}))
    const records = new Map<string, SnapshotEntry>(
        Object.entries(opts.stored ?? {}).map(([did, r]) => [
            did,
            {
                ...r,
                observedAtMs: 1,
                verifiedWith: r.signingKey,
                cid: "bafyreistored",
            },
        ])
    )
    const checks = new Map<string, SnapshotCheck>()
    const checkedAt = new Map<string, number>()
    const attempted = new Map<string, number>()
    const windows: string[] = []
    const quiet: string[] = []
    const deleted = new Set<string>()
    const onChange = vi.fn(async () => {})
    const onRegression = vi.fn(async () => {})
    const onDelete = vi.fn(async () => {})
    const dueCalls: Array<{ before: number; limit: number }> = []

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
        nowMs: () => NOW,
    }
    const deps: RefreshDeps = {
        ingest,
        refreshIndex: {
            dueRefresh: async (before, limit) => {
                dueCalls.push({ before, limit })
                return (opts.due ?? Object.keys(opts.indexed ?? {})).slice(0, limit)
            },
            markChecked: async (did, at) => void checkedAt.set(did, at),
            markAttempted: async (did, at) => void attempted.set(did, at),
            completeQuietly: async (did, rev) => {
                revs.set(did, rev)
                quiet.push(did)
            },
        },
        refreshSnapshots: { putCheck: async (did, c) => void checks.set(did, c) },
        fetchHeadRev: opts.head ?? (async () => "3m1"),
        collection: COLLECTION,
        rkey: RKEY,
    }
    return { deps, attempted, revs, records, checks, checkedAt, windows, quiet, deleted, onChange, onRegression, onDelete, dueCalls }
}

const run = (h: ReturnType<typeof harness>, limit = 64) =>
    refreshDue(h.deps, { nowMs: NOW, staleAfterMs: STALE, limit })

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
            head: async () => "3m2",
            fetchRecord: async () => next,
        })
        const result = await run(h)
        expect(result.outcomes["advanced-quiet"]).toBe(1)
        expect(h.records.get(DID)!.car).toBe(next.car)
        expect(h.records.get(DID)!.rev).toBe("3m2")
        expect(h.revs.get(DID)).toBe("3m2")
        expect(h.quiet).toEqual([DID])
        expect(h.checks.get(DID)).toEqual({ rev: "3m2", checkedAtMs: NOW })
        expect(h.windows).toEqual([])
        expect(h.onChange).not.toHaveBeenCalled()
    })

    it("an advanced rev with a different record CID takes the full settle path (window entry and onChange)", async () => {
        const h = harness({
            indexed: { [DID]: "3m1" },
            stored: { [DID]: fetched("3m1", decl(1)) },
            head: async () => "3m2",
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
            head: async () => "3m1",
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
            head: async () => "3m2",
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
            head: async () => "3m2",
            fetchRecord: async () => fetched("3m2", decl(1), makeKey()),
        })
        const result = await run(h)
        expect(result.outcomes.changed).toBe(1)
        expect(h.quiet).toEqual([])
    })

    it("a transient fetch failure leaves the DID due (no check written)", async () => {
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
            head: async () => "3m2",
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
            head: async () => "3m2",
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
            head: async () => "3m2",
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
            head: async () => "3m2",
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
            head: async () => "3m2",
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
})

describe("refresh re-verifies", () => {
    it.todo("unchanged head with no records row re-fetches and verifies quietly")
    it.todo("unchanged head with an entry verified under a rotated key re-fetches")
    it.todo("an exclusion proof that does not verify does not dispose the snapshot")
    it.todo("quiet advance verifies and stays quiet")
    it.todo("a DID attempted this interval is not retried until the next")
    it.todo("the first pass after upgrade puts no legacy DID in the digest window")
})
