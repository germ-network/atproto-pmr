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
function harness(overrides: Partial<IngestDeps> = {}) {
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
        complete: async (did, rev, observedAtMs) => {
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
        owe: async (did, rev) => void pending.set(did, { rev, attempts: 0, notBeforeMs: 0 }),
        clearPending: async (did) => void pending.delete(did),
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
            rev: "3m2",
            car: new Uint8Array([1, 2, 3]),
            source: PDS,
            signingKey: SIGNING_KEY,
        }),
        nowMs: () => 1_000_000,
        ...overrides,
    }
    return { deps, revs, pending, records, members, deleted, windows, marker: () => marker }
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
                complete: async (did, rev, at) => {
                    order.push("index")
                    await h.deps.index.complete(did, rev, at)
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
                rev: "3m2",
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
        })
        expect(await settle(h.deps, DID)).toBe("stored")
        expect(onChange).not.toHaveBeenCalled()
    })

    it("does not treat an unresolved signing key on either side as a rotation", async () => {
        // Mirrors `compareObservations`' own documented blind spot: a
        // `null` key on either side means rotation cannot be asserted, not
        // that one is ruled out.
        const onChange = vi.fn(async () => {})
        const h = harness({
            onChange,
            fetchRecord: async () => ({
                rev: "3m2",
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
        })
        expect(await settle(h.deps, DID)).toBe("stored")
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
            fetchRecord: async () => ({
                rev: "3m1",
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
        const h = harness({ verify: async () => false })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settle(h.deps, DID)).toBe("rejected")
        expect(h.records.size).toBe(0)
        expect(h.revs.size).toBe(0)
        expect(h.pending.has(DID)).toBe(false)
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
            fetchRecord: async () => ({
                rev: "3m9",
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
            verify: async () => false,
            fetchRecord: async () => ({
                rev: "3m1",
                car: new Uint8Array([1]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }),
        })
        await intake(h.deps, { collection: COLLECTION }, commit("3m1"), "c1")
        expect(await settleDue(h.deps)).toBe(0)
        expect(h.pending.size).toBe(0)
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
