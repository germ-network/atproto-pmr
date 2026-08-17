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
import { decodeEvent, type CommitEvent } from "../src/jetstream"
import { intake, settle, settleDue, type IngestDeps } from "../src/ingest"
import {
    compareObservations,
    compareRev,
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
    let sealedThrough: number | null = null

    const index: MonitorIndex = {
        readCursor: async () => null,
        intake: async ({ did, rev }) => {
            if (revs.get(did) === rev) return { outcome: "duplicate" }
            pending.set(did, { rev, attempts: 0, notBeforeMs: 0 })
            return { outcome: "accepted" }
        },
        complete: async (did, rev, observedAtMs) => {
            revs.set(did, rev)
            const w = Math.floor(observedAtMs / 600_000)
            const set = members.get(w) ?? new Set<string>()
            set.add(did)
            members.set(w, set)
            pending.delete(did)
        },
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
        changedSince: async () => ({ dids: [], nextCursor: "0" }),
        closedWindowsWithMembers: async (current, limit) =>
            [...members.keys()].filter((w) => w < current).sort((a, b) => a - b).slice(0, limit),
        windowMembers: async (w) => [...(members.get(w) ?? [])].sort(),
        dropWindow: async (w) => void members.delete(w),
        readSealedThrough: async () => sealedThrough,
        setSealedThrough: async (w) => void (sealedThrough = w),
    }

    const snapshot: SnapshotStore = {
        getRecord: async (did) => records.get(did) ?? null,
        putRecord: async (did, entry) => void records.set(did, entry),
        getSealedWindow: async (id) => windows.get(id) ?? null,
        putSealedWindow: async (id, f) => void windows.set(id, f),
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
    return { deps, revs, pending, records, members, windows, sealedThrough: () => sealedThrough }
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
