/**
 * Ingest's two properties worth pinning: a duplicate costs nothing, and a
 * failed fetch stays owed.
 *
 * Both matter because of how this component actually runs — the socket is
 * interrupted routinely, every reconnect replays a segment of
 * already-applied events, and the stream will never redeliver an event
 * whose fetch failed. The cursor guarantees coverage only if the pending
 * set covers the gap between "seen" and "stored".
 */
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import { decodeEvent, type CommitEvent } from "../src/jetstream"
import { intake, settle, settleDue, type IngestDeps } from "../src/ingest"
import {
    compareObservations,
    compareRev,
    FETCH_AS_OF_SKEW_MS,
    type BackfillProgress,
    type DigestMarker,
    type MonitorIndex,
    type SnapshotEntry,
    type SnapshotStore,
} from "../src/storage"

const COLLECTION = "com.germnetwork.declaration"
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const CID = "bafyreiexamplecid"

function commit(rev: string, collection = COLLECTION): CommitEvent {
    const e = decodeEvent(
        JSON.stringify({
            payload: {
                $type: "…#commit",
                did: DID,
                collection,
                rev,
                rkey: "self",
                operation: "update",
            },
        })
    )
    if (e === null || e.kind !== "commit") throw new Error("fixture is not a commit")
    return e
}

/** In-memory stand-ins; the real ones are one DO and one KV namespace. */
function harness(overrides: Partial<IngestDeps> & { rev?: string } = {}) {
    const { rev: fetchedRev = "3m2", ...depOverrides } = overrides
    const attempted = new Map<string, number>()
    const completed: Array<{ cid: string; verifiedWith: string }> = []
    const revs = new Map<string, string>()
    const pending = new Map<string, { rev: string; attempts: number; notBeforeMs: number }>()
    const records = new Map<string, SnapshotEntry>()
    const windows = new Map<string, Uint8Array>()
    const members = new Map<number, Set<string>>()
    const deleted = new Set<string>()
    let marker: DigestMarker | null = null
    let backfillProgress: BackfillProgress = { done: false, cursor: null }

    const addToWindow = (did: string, observedAtMs: number) => {
        const w = Math.floor(observedAtMs / 600_000)
        const set = members.get(w) ?? new Set<string>()
        set.add(did)
        members.set(w, set)
    }

    const index: MonitorIndex = {
        readCursor: async () => null,
        intake: async ({ did, rev }) => {
            if (revs.get(did) === rev) return { outcome: "duplicate" }
            pending.set(did, { rev, attempts: 0, notBeforeMs: 0 })
            return { outcome: "accepted" }
        },
        complete: async (did, rev, observedAtMs, verified) => {
            completed.push(verified)
            revs.set(did, rev)
            addToWindow(did, observedAtMs)
            pending.delete(did)
            deleted.delete(did)
        },
        completeDeletion: async (did, observedAtMs, permanent) => {
            if (permanent) deleted.add(did)
            addToWindow(did, observedAtMs)
            pending.delete(did)
        },
        isDeleted: async (did) => deleted.has(did),
        duePending: async (nowMs) =>
            [...pending.entries()]
                .filter(([, p]) => p.notBeforeMs <= nowMs)
                .map(([did, p]) => ({ did, ...p })),
        deferPending: async (did, notBeforeMs) => {
            const p = pending.get(did)
            if (p !== undefined) pending.set(did, { ...p, attempts: p.attempts + 1, notBeforeMs })
        },
        revOf: async (did) => revs.get(did) ?? null,
        recordsOf: async () => [],
        holderStateOf: async () => null,
        owe: async (did, rev) => void pending.set(did, { rev, attempts: 0, notBeforeMs: 0 }),
        clearPending: async (did) => void pending.delete(did),
        markAttempted: async (did, at) => void attempted.set(did, at),
        isWatched: async (did) =>
            (revs.has(did) || pending.has(did)) && !deleted.has(did),
        windowMembers: async (w) => [...(members.get(w) ?? [])].sort(),
        dropWindow: async (w) => void members.delete(w),
        readBackfillProgress: async () => backfillProgress,
        setBackfillProgress: async (p) => void (backfillProgress = p),
    }

    const snapshot: SnapshotStore = {
        getRecord: async (did) => records.get(did) ?? null,
        putRecord: async (did, entry) => void records.set(did, entry),
        deleteRecord: async (did) => void records.delete(did),
        getSealedWindow: async (id) => windows.get(id) ?? null,
        putSealedWindow: async (id, f) => void windows.set(id, f),
        getDigestMarker: async () => marker,
        putDigestMarker: async (m) => void (marker = m),
    }

    const deps: IngestDeps = {
        index,
        snapshot,
        fetchRecord: async () => ({
            car: new Uint8Array([1, 2, 3]),
            source: PDS,
            signingKey: SIGNING_KEY,
        }),
        verify: async (_did, record) =>
            record.signingKey === null
                ? { kind: "unverifiable" }
                : { kind: "verified", key: record.signingKey, rev: fetchedRev, cid: CID },
        nowMs: () => 1_000_000,
        ...depOverrides,
    }
    return { deps, revs, pending, attempted, completed, records, members, deleted, windows, marker: () => marker }
}

describe("intake", () => {
    it("accepts an unseen rev and owes a fetch for it", async () => {
        const h = harness()
        expect(await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")).toBe(
            "accepted"
        )
        expect(h.pending.has(DID)).toBe(true)
    })

    it("drops a replayed event WITHOUT owing a fetch", async () => {
        // The property that makes a reconnect affordable: after resume
        // rewinds to a segment boundary, most of what arrives is already
        // applied and must cost an index read, not a PDS round trip.
        const h = harness()
        h.revs.set(DID, "3m1")
        expect(await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")).toBe(
            "duplicate"
        )
        expect(h.pending.size).toBe(0)
    })

    it("ignores a commit on another collection", async () => {
        const h = harness()
        expect(
            await intake(h.deps, { collection: COLLECTION }, commit("3m1", "app.bsky.feed.post"), "c1")
        ).toBe("ignored")
        expect(h.pending.size).toBe(0)
    })

    it("ignores identity events for DIDs it does not hold, re-verifies its own", async () => {
        // Identity events bypass the collection filter and arrive for the
        // whole network, so the snapshot is the filter. For a DID we hold,
        // a re-key changes what its record verifies against.
        const h = harness()
        const id = { kind: "identity" as const, did: DID, seq: 1, timeMs: null }
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("ignored")
        expect(h.pending.size).toBe(0)

        h.revs.set(DID, "3m1")
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("reverify")
        // And it must actually SCHEDULE the re-read it names: a rotation
        // leaves the record unchanged while changing what verifies it, so
        // the dedupe check would otherwise suppress the one fetch needed.
        expect(h.pending.has(DID)).toBe(true)
    })

    it("ignores identity events for a DID already confirmed deleted -- the noise this pins", async () => {
        // Before isDeleted existed: every identity/account/sync event for
        // an already-deleted DID re-owed a fetch, which rediscovered the
        // same deletion and re-pushed to a registered device again --
        // unbounded repeat noise for one already-known fact, not a new
        // change. The rev floor alone can't tell "known-good, watch for
        // rotation" from "known-gone, nothing left to rotate" -- that's
        // exactly what isDeleted is for.
        const h = harness()
        h.revs.set(DID, "3m1")
        h.deleted.add(DID)
        const id = { kind: "identity" as const, did: DID, seq: 1, timeMs: null }

        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("ignored")
        expect(h.pending.size).toBe(0)
    })
})

describe("settle", () => {
    it("writes the bytes before indexing the rev", async () => {
        // Ordering is the failure story: bytes-then-index leaves at worst an
        // orphan the retry re-applies, where index-then-bytes could claim a
        // rev whose record was never stored.
        const order: string[] = []
        const h = harness()
        const spied: IngestDeps = {
            ...h.deps,
            snapshot: {
                ...h.deps.snapshot,
                putRecord: async (did, e) => {
                    order.push("bytes")
                    await h.deps.snapshot.putRecord(did, e)
                },
            },
            index: {
                ...h.deps.index,
                complete: async (did, rev, at, verified) => {
                    order.push("index")
                    await h.deps.index.complete(did, rev, at, verified)
                },
            },
        }
        await settle(spied, DID)
        expect(order).toEqual(["bytes", "index"])
    })

    it("fires the change hook once the rev advances", async () => {
        const onChange = vi.fn(async () => {})
        const h = harness({ onChange })
        await settle(h.deps, DID)
        expect(onChange).toHaveBeenCalledWith(DID, "3m2")
    })

    it("fires the change hook on a pure key rotation, even with rev unchanged", async () => {
        // The identity-event path (`intake`'s "reverify") lands here with
        // an unchanged rev whenever a DID's document rotated without a new
        // commit — a pure key rotation is arguably the single most
        // security-relevant thing this component exists to catch, so it
        // must not go silent just because `rev` didn't move.
        const ROTATED_KEY = "zQ3shRotatedKeyNotARealMultikey00000000000"
        const onChange = vi.fn(async () => {})
        const h = harness({
            onChange,
            fetchRecord: async () => ({
                car: new Uint8Array([1, 2, 3]),
                source: PDS,
                signingKey: ROTATED_KEY,
            }),
        })
        h.revs.set(DID, "3m2")
        h.records.set(DID, {
            rev: "3m2",
            car: new Uint8Array([1, 2, 3]),
            observedAtMs: 500_000,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: CID,
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(onChange).toHaveBeenCalledWith(DID, "3m2")
    })

    it("does not fire the change hook when neither rev nor signing key moved", async () => {
        const onChange = vi.fn(async () => {})
        const h = harness({ onChange })
        h.revs.set(DID, "3m2")
        h.records.set(DID, {
            rev: "3m2",
            car: new Uint8Array([1, 2, 3]),
            observedAtMs: 500_000,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: CID,
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(onChange).not.toHaveBeenCalled()
    })

    it("does not treat an unresolved signing key as a rotation", async () => {
        // Mirrors `compareObservations`' own documented blind spot: a
        // `null` key on either side means rotation cannot be asserted, not
        // that one is ruled out.
        const onChange = vi.fn(async () => {})
        const h = harness({
            onChange,
            fetchRecord: async () => ({
                car: new Uint8Array([1, 2, 3]),
                source: PDS,
                signingKey: null,
            }),
        })
        h.revs.set(DID, "3m2")
        h.records.set(DID, {
            rev: "3m2",
            car: new Uint8Array([1, 2, 3]),
            observedAtMs: 500_000,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: CID,
        })
        expect(await settle(h.deps, DID)).toBe("unverifiable")
        expect(onChange).not.toHaveBeenCalled()
    })

    it("carries the fetch's provenance into the stored entry", async () => {
        // `fetchRecordCar` resolves `source`/`signingKey` and previously
        // threw them away. This is the property that stops that
        // regression: what was fetched must be what gets stored, not just
        // `rev` and `car`.
        const h = harness()
        await settle(h.deps, DID)
        expect(h.records.get(DID)).toMatchObject({ source: PDS, signingKey: SIGNING_KEY })
    })

    it("raises a regression instead of overwriting it", async () => {
        // A rev moving backwards is the alarm the component exists for.
        const onRegression = vi.fn(async () => {})
        const h = harness({
            onRegression,
            rev: "3m1",
            fetchRecord: async () => ({
                car: new Uint8Array([9]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }),
        })
        h.revs.set(DID, "3m9")
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settle(h.deps, DID)).toBe("rejected")
        expect(onRegression).toHaveBeenCalledWith(DID, "3m9", "3m1")
        expect(h.records.has(DID)).toBe(false)
        expect(h.revs.get(DID)).toBe("3m9")
        // Terminal, so the obligation is discharged. Leaving it would
        // retry the same alarming answer on every wake, forever, against
        // the very DID under attack.
        expect(h.pending.has(DID)).toBe(false)
    })

    it("stores nothing when verification fails", async () => {
        const h = harness({ verify: async () => ({ kind: "unverifiable" as const }) })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settle(h.deps, DID)).toBe("unverifiable")
        expect(h.records.size).toBe(0)
        expect(h.revs.size).toBe(0)
    })

    it("a confirmed deletion disposes of the stored record and clears the obligation", async () => {
        // The record previously existed and was served — that's what
        // needs disposing of. Confirming the deletion path actually
        // removes it, not just skips re-adding it.
        const h = harness({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, {
            rev: "3m1",
            car: new Uint8Array([1]),
            observedAtMs: 500_000,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: CID,
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m2"), "c1")

        expect(await settle(h.deps, DID)).toBe("deleted")
        expect(h.records.has(DID)).toBe(false)
        expect(h.pending.has(DID)).toBe(false)
    })

    it("a confirmed deletion fires onDelete, not onChange or onRegression", async () => {
        const onChange = vi.fn(async () => {})
        const onRegression = vi.fn(async () => {})
        const onDelete = vi.fn(async () => {})
        const h = harness({
            onChange,
            onRegression,
            onDelete,
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")

        await settle(h.deps, DID)

        expect(onDelete).toHaveBeenCalledWith(DID)
        expect(onChange).not.toHaveBeenCalled()
        expect(onRegression).not.toHaveBeenCalled()
    })

    it("a genuinely unresolvable DID (never seen before) is still handled cleanly by a deletion", async () => {
        // No prior record, no prior indexed rev -- deleteRecord/clearPending
        // on nothing must no-op rather than throw.
        const h = harness({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        await expect(settle(h.deps, DID)).resolves.toBe("deleted")
    })

    it("a confirmed deletion reaches the digest window, same as a stored change would", async () => {
        // Before completeDeletion existed, the deleted branch only cleared
        // the pending row -- the DID never entered window_members, so the
        // community-wide digest never learned the single most alarming
        // kind of change this component exists to catch.
        const h = harness({
            nowMs: () => 500_000,
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        await settle(h.deps, DID)

        expect(await h.deps.index.windowMembers(0)).toContain(DID)
    })

    it("a confirmed deletion marks the DID isDeleted, without disturbing the rev floor", async () => {
        const h = harness({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        h.revs.set(DID, "3m1")
        await intake(h.deps, { collection: COLLECTION }, commit("3m2"), "c1")
        await settle(h.deps, DID)

        expect(await h.deps.index.isDeleted(DID)).toBe(true)
        // The floor survives -- clearing it would let a later republish at
        // a lower rev than "3m1" launder a rollback past regression
        // detection.
        expect(h.revs.get(DID)).toBe("3m1")
    })

    it("a resurrection (a later successful settle) clears the isDeleted mark", async () => {
        const h = harness({
            rev: "3m9",
            fetchRecord: async () => ({
                car: new Uint8Array([9]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }),
        })
        h.deleted.add(DID)
        await intake(h.deps, { collection: COLLECTION }, commit("3m9"), "c1")

        expect(await settle(h.deps, DID)).toBe("stored")
        expect(await h.deps.index.isDeleted(DID)).toBe(false)
    })

    it("a REVERSIBLE terminal state (RepoDeactivated) disposes, pushes, and reaches the digest -- but does NOT mark isDeleted", async () => {
        const onDelete = vi.fn(async () => {})
        const h = harness({
            onDelete,
            nowMs: () => 500_000,
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoDeactivated", false)
            },
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, {
            rev: "3m1",
            car: new Uint8Array([1]),
            observedAtMs: 100,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: CID,
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m2"), "c1")

        expect(await settle(h.deps, DID)).toBe("deleted")
        expect(h.records.has(DID)).toBe(false)
        expect(onDelete).toHaveBeenCalledWith(DID)
        expect(await h.deps.index.windowMembers(0)).toContain(DID)
        expect(await h.deps.index.isDeleted(DID)).toBe(false)
    })

    it("the wedge this all pins: a reinstated account (no republish) is rechecked, NOT stuck forever", async () => {
        // A reversible terminal state must not permanently suppress the
        // one signal that would ever notice a reversal: a later
        // identity/account/sync event for the same DID. Walks the full
        // path -- settle marks it reversibly gone, then a fresh identity
        // event must still schedule a recheck, exactly as it would for
        // any other DID this monitor already holds.
        const h = harness({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoDeactivated", false)
            },
        })
        h.revs.set(DID, "3m1")
        await intake(h.deps, { collection: COLLECTION }, commit("3m2"), "c1")
        await settle(h.deps, DID)
        expect(h.pending.has(DID)).toBe(false)

        const id = { kind: "account" as const, did: DID, seq: 2, timeMs: null }
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c2")).toBe("reverify")
        expect(h.pending.has(DID)).toBe(true)
    })
})

describe("settleDue", () => {
    it("keeps a failed fetch owed, with backoff", async () => {
        // Jetstream will not redeliver, so the pending row is the only
        // thing standing between a PDS outage and a silently dropped DID.
        const h = harness({
            fetchRecord: async () => {
                throw new Error("PDS unreachable")
            },
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(0)

        const owed = h.pending.get(DID)
        expect(owed?.attempts).toBe(1)
        expect(owed?.notBeforeMs).toBeGreaterThan(h.deps.nowMs())
    })

    it("counts only what was stored, never a rejection", async () => {
        // A rejection is not a failure, but it is not progress either;
        // reporting it as settled hid a permanent retry loop.
        const h = harness({
            verify: async () => ({ kind: "unverifiable" as const }),
            fetchRecord: async () => ({
                car: new Uint8Array([1]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }),
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(0)
        expect(h.pending.get(DID)?.notBeforeMs).toBeGreaterThan(h.deps.nowMs())
    })

    it("clears the obligation once the fetch succeeds", async () => {
        const h = harness()
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(1)
        expect(h.pending.size).toBe(0)
        expect(h.revs.get(DID)).toBe("3m2")
    })

    it("a confirmed deletion is discharged, NOT retried like a transient failure — the bug this pins", async () => {
        // Before this fix: guardedFetchBytes threw a generic Error on
        // every non-ok status, so settle() could not tell "the record is
        // gone" from "the PDS is unreachable" -- both propagated out of
        // fetchRecord, settleDue's catch treated a confirmed deletion the
        // same as an outage, and deferPending re-queued it with backoff
        // forever. A declaration being deleted -- the single most
        // alarming kind of change this component exists to catch -- would
        // never actually settle, never push, and would sit retrying
        // against an answer that could not change.
        const h = harness({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            },
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")

        expect(await settleDue(h.deps)).toBe(0)
        // The proof: gone from pending entirely, not deferred with a
        // later notBeforeMs the way a transient failure is (compare the
        // "keeps a failed fetch owed, with backoff" test above).
        expect(h.pending.has(DID)).toBe(false)
    })
})

describe("compareRev", () => {
    it("orders TIDs lexicographically, and treats first sight as advance", () => {
        expect(compareRev(null, "3m1")).toBe("advanced")
        expect(compareRev("3m1", "3m1")).toBe("unchanged")
        expect(compareRev("3m1", "3m2")).toBe("advanced")
        expect(compareRev("3m2", "3m1")).toBe("regressed")
    })
})

describe("compareObservations", () => {
    const KEY_A = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
    const KEY_B = "zQ3shPJ8gWuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmothr"
    const HOST_A = "https://pds-a.example"
    const HOST_B = "https://pds-b.example"
    const CAR_1 = new Uint8Array([1, 2, 3])
    const CAR_2 = new Uint8Array([9, 9, 9])

    function observation(overrides: Partial<Parameters<typeof compareObservations>[0]> = {}) {
        return { rev: "3m1", source: HOST_A, signingKey: KEY_A, car: CAR_1, ...overrides }
    }

    it("agrees when rev, content, and source all match", () => {
        expect(compareObservations(observation(), observation())).toBe("agree")
    })

    it("calls it skew when only the rev differs under one authority", () => {
        expect(compareObservations(observation(), observation({ rev: "3m2" }))).toBe("skew")
    })

    it("calls it rotated when the two sides resolved different signing keys", () => {
        // Pre-empts every other check: a rev or content comparison across a
        // rotation answers a question neither observation was asked.
        expect(
            compareObservations(
                observation({ rev: "3m2", car: CAR_2 }),
                observation({ signingKey: KEY_B })
            )
        ).toBe("rotated")
    })

    it("calls it equivocation when the SAME rev carries DIFFERENT content", () => {
        // The strongest signal this function can raise from rev/content
        // alone — escalate to decode-and-verify, per the doc comment on
        // ObservationComparison; this function does not parse CAR, so it
        // cannot itself distinguish real equivocation from non-deterministic
        // CAR serialization between two honest fetches.
        expect(compareObservations(observation(), observation({ car: CAR_2 }))).toBe(
            "equivocation"
        )
    })

    it("calls it different-source when rev and content agree but the host does not", () => {
        expect(compareObservations(observation(), observation({ source: HOST_B }))).toBe(
            "different-source"
        )
    })

    it("does not assert rotation when only one side resolved a signing key", () => {
        // There is nothing to compare a null against — treated as
        // unresolved, not as a mismatch, so the weaker checks still apply.
        expect(compareObservations(observation(), observation({ signingKey: null }))).toBe(
            "agree"
        )
    })

    it("still raises equivocation with an unresolved key, on the rev/content signal alone", () => {
        // The fallback in compareObservations is only sound if it can still
        // reach the alarm classes — a null signingKey must not silently cap
        // the result at something weaker than what rev/content alone
        // supports.
        expect(
            compareObservations(observation(), observation({ signingKey: null, car: CAR_2 }))
        ).toBe("equivocation")
    })

    it("still raises skew with an unresolved key, on the rev signal alone", () => {
        expect(
            compareObservations(observation(), observation({ signingKey: null, rev: "3m2" }))
        ).toBe("skew")
    })
})

describe("settle keeps the stored DID document", () => {
    const FETCHED_AT = 777_000
    const DOCUMENT = { id: DID, alsoKnownAs: ["at://alice.example"] }
    const withDocument = () => ({
        car: new Uint8Array([1, 2, 3]),
        source: PDS,
        signingKey: SIGNING_KEY,
        didDocument: { document: DOCUMENT, fetchedAtMs: FETCHED_AT },
    })
    function sink() {
        const writes: Array<{ did: string; document: unknown; asOfMs: number }> = []
        return {
            writes,
            didDocuments: {
                recordDidDocument: vi.fn(async (did: string, document: unknown, asOfMs: number) => {
                    writes.push({ did, document, asOfMs })
                }),
                markDidDocumentStale: vi.fn(async () => {}),
            },
        }
    }

    it("records the fetched document as of its fetch time less FETCH_AS_OF_SKEW_MS on a stored outcome", async () => {
        const s = sink()
        const h = harness({ fetchRecord: async () => withDocument(), didDocuments: s.didDocuments })
        h.pending.set(DID, { rev: "3m2", attempts: 0, notBeforeMs: 0 })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(s.writes).toEqual([
            { did: DID, document: DOCUMENT, asOfMs: FETCHED_AT - FETCH_AS_OF_SKEW_MS },
        ])
    })

    it("records the fetched document when the record is unverifiable, then withdraws trust in it", async () => {
        const s = sink()
        const h = harness({
            fetchRecord: async () => withDocument(),
            verify: async () => ({ kind: "unverifiable" as const }),
            didDocuments: s.didDocuments,
        })
        expect(await settle(h.deps, DID)).toBe("unverifiable")
        expect(s.writes).toHaveLength(1)
        expect(s.didDocuments.markDidDocumentStale).toHaveBeenCalledExactlyOnceWith(
            DID,
            FETCHED_AT - FETCH_AS_OF_SKEW_MS
        )
    })

    it("marks nothing stale when the record settles or the fetch carried no document", async () => {
        const s = sink()
        const stored = harness({ fetchRecord: async () => withDocument(), didDocuments: s.didDocuments })
        await settle(stored.deps, DID)
        const bare = harness({ verify: async () => ({ kind: "unverifiable" as const }), didDocuments: s.didDocuments })
        await settle(bare.deps, DID)
        expect(s.didDocuments.markDidDocumentStale).not.toHaveBeenCalled()
    })

    it("records the fetched document even when the rev regressed", async () => {
        const s = sink()
        const h = harness({ fetchRecord: async () => withDocument(), didDocuments: s.didDocuments })
        h.revs.set(DID, "3m9")
        expect(await settle(h.deps, DID)).toBe("rejected")
        expect(s.writes).toHaveLength(1)
    })

    it("records nothing when the fetch carried no document", async () => {
        const s = sink()
        const h = harness({ didDocuments: s.didDocuments })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(s.writes).toEqual([])
    })

    it("records nothing when didDocuments is not wired", async () => {
        const h = harness({ fetchRecord: async () => withDocument() })
        expect(await settle(h.deps, DID)).toBe("stored")
    })

    it("a failing document write does not fail the settle", async () => {
        const h = harness({
            fetchRecord: async () => withDocument(),
            didDocuments: {
                recordDidDocument: async () => {
                    throw new Error("store down")
                },
                markDidDocumentStale: async () => {},
            },
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(h.records.get(DID)?.rev).toBe("3m2")
    })
})

describe("identity events and the signing-key cache", () => {
    const id = { kind: "identity" as const, did: DID, seq: 1, timeMs: null }

    function withKeyUpdates() {
        const owed: Array<{ did: string; update: unknown; plcSeq?: number }> = []
        const keyUpdates = {
            oweKeyUpdate: async (did: string, update: unknown, plcSeq?: number) => {
                owed.push({ did, update, plcSeq })
            },
        }
        return { owed, keyUpdates }
    }

    it("reverify with keyUpdates set → also owes a delete of the DID's cached key", async () => {
        const { owed, keyUpdates } = withKeyUpdates()
        const h = harness({ keyUpdates })
        h.revs.set(DID, "3m1")
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("reverify")
        expect(owed).toEqual([{ did: DID, update: { kind: "delete" }, plcSeq: undefined }])
    })

    it("reverify without keyUpdates → unchanged behaviour", async () => {
        const h = harness()
        h.revs.set(DID, "3m1")
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("reverify")
        expect(h.pending.has(DID)).toBe(true)
    })

    it("ignored identity event (unwatched or permanently deleted) → no key update owed", async () => {
        const { owed, keyUpdates } = withKeyUpdates()
        const h = harness({ keyUpdates })
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("ignored")
        h.revs.set(DID, "3m1")
        h.deleted.add(DID)
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("ignored")
        expect(owed).toEqual([])
    })
})

describe("settle verifies at ingest", () => {
    const FETCHED_AT = 777_000
    const DOCUMENT = { id: DID }
    const ROTATED_KEY = "zQ3shRotatedKeyNotARealMultikey00000000000"
    const withDocument = (signingKey: string | null = SIGNING_KEY) => ({
        car: new Uint8Array([1, 2, 3]),
        source: PDS,
        signingKey,
        didDocument: { document: DOCUMENT, fetchedAtMs: FETCHED_AT },
    })
    const unverifiable = async () => ({ kind: "unverifiable" as const })
    const stale = () => vi.fn(async () => {})
    const sink = () => ({ recordDidDocument: vi.fn(async () => {}), markDidDocumentStale: stale() })
    const storedEntry = (overrides: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
        rev: "3m1",
        car: new Uint8Array([1]),
        observedAtMs: 500_000,
        source: PDS,
        signingKey: SIGNING_KEY,
        verifiedWith: SIGNING_KEY,
        cid: CID,
        ...overrides,
    })

    it("verified CAR is stored with the signed commit rev, key and cid", async () => {
        const h = harness({
            rev: "3m5",
            verify: async () => ({ kind: "verified", key: SIGNING_KEY, rev: "3m5", cid: "bafyreisigned" }),
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(h.records.get(DID)).toMatchObject({
            rev: "3m5",
            verifiedWith: SIGNING_KEY,
            cid: "bafyreisigned",
        })
        expect(h.revs.get(DID)).toBe("3m5")
        expect(h.completed).toEqual([{ cid: "bafyreisigned", verifiedWith: SIGNING_KEY }])
    })

    it("verified exclusion proof at a current rev disposes the snapshot reversibly", async () => {
        const onDelete = vi.fn(async () => {})
        const h = harness({
            onDelete,
            verify: async () => ({ kind: "verified-absent", key: SIGNING_KEY, rev: "3m2" }),
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, storedEntry())
        expect(await settle(h.deps, DID)).toBe("deleted")
        expect(h.records.has(DID)).toBe(false)
        expect(h.deleted.has(DID)).toBe(false)
        expect(onDelete).toHaveBeenCalledWith(DID)
    })

    it("older exclusion proof does not delete a newer record", async () => {
        const onRegression = vi.fn(async () => {})
        const h = harness({
            onRegression,
            verify: async () => ({ kind: "verified-absent", key: SIGNING_KEY, rev: "3m1" }),
        })
        h.revs.set(DID, "3m9")
        h.records.set(DID, storedEntry({ rev: "3m9" }))
        expect(await settle(h.deps, DID)).toBe("rejected")
        expect(h.records.has(DID)).toBe(true)
        expect(onRegression).toHaveBeenCalledWith(DID, "3m9", "3m1")
    })

    it("unverifiable CAR keeps the entry, clears pending and marks attempted", async () => {
        const onChange = vi.fn(async () => {})
        const h = harness({ verify: unverifiable, onChange })
        h.revs.set(DID, "3m1")
        h.records.set(DID, storedEntry())
        h.pending.set(DID, { rev: "3m2", attempts: 0, notBeforeMs: 0 })
        expect(await settle(h.deps, DID)).toBe("unverifiable")
        expect(h.records.get(DID)?.rev).toBe("3m1")
        expect(h.revs.get(DID)).toBe("3m1")
        expect(h.pending.has(DID)).toBe(false)
        expect(h.attempted.get(DID)).toBe(h.deps.nowMs())
        expect(onChange).not.toHaveBeenCalled()
    })

    it("unverifiable CAR for a still-watched DID keeps its stored document", async () => {
        const s = sink()
        const h = harness({
            verify: unverifiable,
            fetchRecord: async () => withDocument(),
            didDocuments: s,
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, storedEntry())
        await settle(h.deps, DID)
        expect(s.markDidDocumentStale).not.toHaveBeenCalled()
    })

    it("unverifiable CAR for a DID never held withdraws its stored document", async () => {
        const s = sink()
        const h = harness({
            verify: unverifiable,
            fetchRecord: async () => withDocument(),
            didDocuments: s,
        })
        await settle(h.deps, DID)
        expect(s.markDidDocumentStale).toHaveBeenCalledExactlyOnceWith(
            DID,
            FETCHED_AT - FETCH_AS_OF_SKEW_MS
        )
    })

    it("verified absence leaving the DID unwatched withdraws its stored document", async () => {
        const s = sink()
        const h = harness({
            verify: async () => ({ kind: "verified-absent", key: SIGNING_KEY, rev: "3m2" }),
            fetchRecord: async () => withDocument(),
            didDocuments: s,
        })
        h.pending.set(DID, { rev: "3m2", attempts: 0, notBeforeMs: 0 })
        expect(await settle(h.deps, DID)).toBe("deleted")
        expect(s.markDidDocumentStale).toHaveBeenCalledExactlyOnceWith(
            DID,
            FETCHED_AT - FETCH_AS_OF_SKEW_MS
        )
    })

    it("a malformed CAR is unverifiable, not a transient failure", async () => {
        const h = harness({ verify: unverifiable })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(0)
        // Deferred by the retry interval, not by transient-failure backoff.
        const owed = h.pending.get(DID)
        expect(owed?.notBeforeMs).toBe(h.deps.nowMs() + 3_600_000)
    })

    it("an unverifiable result under a rotated key pushes onChange once", async () => {
        const onChange = vi.fn(async () => {})
        const h = harness({
            onChange,
            verify: unverifiable,
            fetchRecord: async () => withDocument(ROTATED_KEY),
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, storedEntry())
        await settle(h.deps, DID)
        await settle(h.deps, DID)
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange).toHaveBeenCalledWith(DID, "3m1")
        expect(h.records.get(DID)?.seenKey).toBe(ROTATED_KEY)
        expect(h.records.get(DID)?.rev).toBe("3m1")
    })

    it("a never-held DID that comes back unverifiable stays owed and is retried after the interval", async () => {
        let now = 1_000_000
        const sinkStub = sink()
        const fetchRecord = vi.fn(async () => withDocument())
        const h = harness({
            verify: unverifiable,
            fetchRecord,
            nowMs: () => now,
            unverifiableRetryMs: 600_000,
            didDocuments: sinkStub,
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(0)
        expect(h.pending.has(DID)).toBe(true)
        expect(await h.deps.index.isWatched(DID)).toBe(true)
        expect(fetchRecord).toHaveBeenCalledTimes(1)
        expect(sinkStub.markDidDocumentStale).not.toHaveBeenCalled()

        await settleDue(h.deps)
        expect(fetchRecord).toHaveBeenCalledTimes(1)

        now += 600_000
        await settleDue(h.deps)
        expect(fetchRecord).toHaveBeenCalledTimes(2)
    })

    it("reverify after an identity event verifies under the newly fetched key", async () => {
        const verify = vi.fn(async (_did: string, record: { signingKey: string | null }) => ({
            kind: "verified" as const,
            key: record.signingKey!,
            rev: "3m1",
            cid: CID,
        }))
        const onChange = vi.fn(async () => {})
        const h = harness({
            verify,
            onChange,
            fetchRecord: async () => withDocument(ROTATED_KEY),
        })
        h.revs.set(DID, "3m1")
        h.records.set(DID, storedEntry())
        const id = { kind: "identity" as const, did: DID, seq: 1, timeMs: null }
        expect(await intake(h.deps, { collection: COLLECTION }, id, "c1")).toBe("reverify")
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(verify.mock.calls[0]![1].signingKey).toBe(ROTATED_KEY)
        expect(h.records.get(DID)).toMatchObject({ verifiedWith: ROTATED_KEY })
        expect(onChange).toHaveBeenCalledWith(DID, "3m1")
    })
})
