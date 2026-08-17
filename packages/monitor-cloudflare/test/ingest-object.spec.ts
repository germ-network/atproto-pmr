/**
 * The index against the real Durable Object storage engine.
 *
 * The properties worth pinning here are the ones the design leans on and
 * an in-memory fake cannot prove: that intake and the cursor move together
 * across an eviction, that a replayed event costs no fetch, and that a
 * failed fetch stays owed — because the stream will not redeliver it.
 */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    decodeDigestWindows,
    mightHaveChanged,
    sealDueWindows,
    settleDue,
    sweepBackfill,
    type FetchedRecord,
} from "@germ-network/atproto-pmr-monitor"
import { DIGEST_MARKER_KEY, kvSnapshotStore } from "../src/snapshot-store"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

let n = 0
function freshStub(): DurableObjectStub<MonitorIngest> {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`ingest-${n}`))
}

/** Reach in to drive the ingest object with a stubbed authoritative fetch. */
/** Enter the object with its own type, mirroring inPMR upstream. */
function inMonitorObj<R>(
    stub: DurableObjectStub<MonitorIngest>,
    fn: (obj: MonitorIngest) => R | Promise<R>
): Promise<R> {
    return runInDurableObject(stub, (instance) => fn(instance as MonitorIngest))
}

function withFetch(
    stub: DurableObjectStub<MonitorIngest>,
    fetchRecord: (did: string) => Promise<FetchedRecord>
) {
    return runInDurableObject(stub, async (obj: MonitorIngest) => {
        ;(obj as unknown as { fetchRecord: typeof fetchRecord }).fetchRecord = fetchRecord
        return settleDue({
            index: obj,
            snapshot: kvSnapshotStore(testEnv),
            fetchRecord,
            nowMs: () => Date.now(),
        })
    })
}

describe("the index", () => {
    it("advances the cursor with intake, and survives eviction", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "1786695916763191")
        )
        // A separate entry into the object: state came from storage, not memory.
        const cursor = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.readCursor()
        )
        expect(cursor).toBe("1786695916763191")
    })

    it("owes a fetch for an unseen rev", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            return obj.duePending(Date.now(), 10)
        })
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("drops a replayed event without owing a fetch, but still advances", async () => {
        // Resume rewinds to a segment boundary, so most of what arrives
        // after a reconnect is already applied. It must cost an index read,
        // not a PDS round trip — while still accounting for the event.
        const stub = freshStub()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now())
            const outcome = await obj.intake({ did: DID, rev: "3m1" }, "200")
            return {
                outcome: outcome.outcome,
                owed: (await obj.duePending(Date.now(), 10)).length,
                cursor: await obj.readCursor(),
            }
        })
        expect(result).toEqual({ outcome: "duplicate", owed: 0, cursor: "200" })
    })

    it("clears the obligation on completion", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.complete(DID, "3m1", Date.now())
            return obj.duePending(Date.now(), 10)
        })
        expect(owed).toEqual([])
    })
})

describe("settling what is owed", () => {
    it("stores the record and indexes the rev", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "100")
        )
        const car = new Uint8Array([1, 2, 3])
        const settled = await withFetch(stub, async () => ({
            rev: "3m1",
            car,
            source: PDS,
            signingKey: SIGNING_KEY,
        }))
        expect(settled).toBe(1)

        const stored = await kvSnapshotStore(testEnv).getRecord(DID)
        expect(stored?.rev).toBe("3m1")
        expect([...(stored?.car ?? [])]).toEqual([1, 2, 3])
        expect(stored?.source).toBe(PDS)
        expect(stored?.signingKey).toBe(SIGNING_KEY)
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.revOf(DID))).toBe("3m1")
    })

    it("keeps a failed fetch owed, with backoff", async () => {
        // Jetstream will not redeliver, so the pending row is the only
        // thing between a PDS outage and a silently dropped DID.
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "100")
        )
        const settled = await withFetch(stub, async () => {
            throw new Error("PDS unreachable")
        })
        expect(settled).toBe(0)

        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now() + 10 ** 9, 10)
        )
        expect(owed[0]?.attempts).toBe(1)
        expect(owed[0]?.notBeforeMs).toBeGreaterThan(Date.now())
    })

    it("holds a backed-off fetch until its time comes", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.deferPending(DID, Date.now() + 10 ** 6)
        })
        const dueNow = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(dueNow).toEqual([])
    })
})

describe("the way in", () => {
    it("start() arms the alarm, so a deployed object is not inert", async () => {
        // There was no entry point at all: connect armed the alarm and
        // only the alarm called connect. A fresh object never started.
        const stub = freshStub()
        const before = await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())
        expect(before).toBeNull()

        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            // connect() reaches the network; arming is the part under test.
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const after = await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())
        expect(after).not.toBeNull()
    })

    it(
        "connect() aborts a stalled Jetstream upgrade rather than hanging forever",
        async () => {
            // Real regression: an upgrade fetch that accepts the connection
            // and never completes the handshake used to hang connect()
            // forever -- and because this runs inside alarm(), which is
            // single-threaded with every other call into the object, the
            // WHOLE object wedged: digestPage() and every other RPC queued
            // behind it with no way out. Proven by a mock fetch that never
            // resolves on its own; connect() must still settle (by
            // rejecting), not hang. Asserts the outcome, not elapsed time.
            const stub = freshStub()
            const original = globalThis.fetch
            globalThis.fetch = ((_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("The operation was aborted.", "AbortError"))
                    })
                })) as typeof fetch
            try {
                await expect(
                    runInDurableObject(stub, (obj: MonitorIngest) => obj.connect())
                ).rejects.toThrow(/abort/i)
            } finally {
                globalThis.fetch = original
            }
        },
        10_000
    )

    it("owes a re-read on demand, past the dedupe check", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now())
            // intake would call this a duplicate; a rotation still needs it.
            await obj.owe(DID, "3m1")
            return obj.duePending(Date.now(), 10)
        })
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("clearPending discharges without indexing", async () => {
        const stub = freshStub()
        const after = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.clearPending(DID)
            return { owed: await obj.duePending(Date.now(), 10), rev: await obj.revOf(DID) }
        })
        expect(after.owed).toEqual([])
        expect(after.rev).toBeNull()
    })
})

describe("digest windows", () => {
    it("records a completed fetch in the window it was OBSERVED in", async () => {
        // Observation time, not event time: a sealed filter cannot be
        // amended, and the retry path settles arbitrarily late.
        const stub = freshStub()
        const observedAtMs = 12 * 600_000 + 5_000
        const members = await inMonitorObj(stub, async (obj) => {
            await obj.complete(DID, "3m1", observedAtMs)
            // Identified by START INSTANT, so the width can be retuned
            // without old and new windows colliding on one key.
            return obj.windowMembers(12 * 600_000)
        })
        expect(members).toEqual([DID])
    })

    it("seals closed windows on the alarm, leaving the open one alone", async () => {
        const stub = freshStub()
        const now = Date.now()
        const currentWindow = Math.floor(now / 600_000) * 600_000
        const sealed = await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:old", "3m1", currentWindow - 2 * 600_000)
            await obj.complete("did:plc:now", "3m2", now)
            // As if sealing had already progressed to just before the old
            // window on a prior tick — a fresh install starts coverage
            // "now", not retroactively, so this test needs a marker to
            // exercise catching up on a real backlog.
            await kvSnapshotStore(testEnv).putDigestMarker({
                sealedThrough: currentWindow - 3 * 600_000,
                oldest: currentWindow - 3 * 600_000,
            })
            return sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                retentionMs: 7 * 24 * 60 * 60 * 1000,
                nowMs: () => now,
            })
        })
        // Both the old window AND the empty one between it and current seal
        // — every window in range gets a physical entry now, not only the
        // ones with members.
        expect(sealed).toEqual([currentWindow - 2 * 600_000, currentWindow - 600_000])

        const bytes = await kvSnapshotStore(testEnv).getSealedWindow(String(currentWindow - 2 * 600_000))
        const [w] = decodeDigestWindows(bytes!)
        expect(mightHaveChanged(w, "did:plc:old")).toBe(true)
        expect(mightHaveChanged(w, "did:plc:now")).toBe(false)

        // The current window is still accumulating.
        const stillOpen = await inMonitorObj(stub, (obj) => obj.windowMembers(currentWindow))
        expect(stillOpen).toEqual(["did:plc:now"])
    })

    it("keys a window by its start instant, divisible by the width", async () => {
        // Identity is the start instant, not an index. An index is
        // ambiguous the moment the width is tuned — index 5 means minutes
        // 50-60 at ten minutes and 25-30 at five — so every key would mean
        // two things. An instant means one thing under any width.
        //
        // It does NOT make retuning free: an instant divisible by both
        // widths is a shared key, so changing the width requires clearing
        // digest state (see the note on `DIGEST_WINDOW_MS`). What it buys
        // is that the collision surface is aligned boundaries rather than
        // every key, and any survivor is self-describing about its width.
        const stub = freshStub()
        const t = 12 * 600_000 + 5_000
        const members = await inMonitorObj(stub, async (obj) => {
            await obj.complete(DID, "3m1", t)
            return obj.windowMembers(12 * 600_000)
        })
        expect(members).toEqual([DID])
        expect((12 * 600_000) % 600_000).toBe(0)
    })

    it("tracks the digest marker, the boundary between empty and unpublished", async () => {
        // The marker lives in KV now, not the object's own storage — a
        // request handler reads it directly and never touches the object
        // at all.
        const stub = freshStub()
        const now = Date.now()
        // KV, unlike a fresh DO id, is shared across this file's tests —
        // an earlier test may have already written the singleton marker
        // key, so start from a known-clean state rather than assume one.
        await testEnv.records.delete(DIGEST_MARKER_KEY)
        const before = await kvSnapshotStore(testEnv).getDigestMarker()
        expect(before).toBeNull()
        await inMonitorObj(stub, (obj) =>
            sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                retentionMs: 7 * 24 * 60 * 60 * 1000,
                nowMs: () => now,
            })
        )
        const marker = await kvSnapshotStore(testEnv).getDigestMarker()
        expect(marker?.sealedThrough).toBe(Math.floor(now / 600_000) * 600_000 - 600_000)
    })
})

describe("backfill", () => {
    it("starts unstarted, and persists progress across a separate entry into the object", async () => {
        const stub = freshStub()
        const before = await inMonitorObj(stub, (obj) => obj.readBackfillProgress())
        expect(before).toEqual({ done: false, cursor: null })

        await inMonitorObj(stub, (obj) =>
            obj.setBackfillProgress({ done: false, cursor: "page-2" })
        )
        // A separate entry: state came from storage, not memory.
        expect(await inMonitorObj(stub, (obj) => obj.readBackfillProgress())).toEqual({
            done: false,
            cursor: "page-2",
        })
    })

    it("discovers a DID via the real index, and owes it for the next settle pass", async () => {
        const stub = freshStub()
        const swept = await inMonitorObj(stub, (obj) =>
            sweepBackfill({
                index: obj,
                listRepos: async () => ({ dids: [DID], nextCursor: null }),
            })
        )
        expect(swept).toEqual({ discovered: 1, done: true })

        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("does not re-discover a DID the live tail already indexed", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.complete(DID, "3m1", Date.now())
        )
        const swept = await inMonitorObj(stub, (obj) =>
            sweepBackfill({
                index: obj,
                listRepos: async () => ({ dids: [DID], nextCursor: null }),
            })
        )
        expect(swept.discovered).toBe(0)
        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(owed).toEqual([])
    })
})

describe("the snapshot store", () => {
    it("keeps records without a TTL — an unchanged record stays served", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putRecord("did:plc:ttl", {
            rev: "3m1",
            car: new Uint8Array([9]),
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
        })
        const back = await store.getRecord("did:plc:ttl")
        expect(back).toMatchObject({
            rev: "3m1",
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
        })
    })

    it("returns null for a DID it has never seen", async () => {
        expect(await kvSnapshotStore(testEnv).getRecord("did:plc:nobody")).toBeNull()
    })

    it("round-trips a sealed window", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putSealedWindow("w1", new Uint8Array([4, 5]))
        expect([...((await store.getSealedWindow("w1")) ?? [])]).toEqual([4, 5])
        expect(await store.getSealedWindow("w-absent")).toBeNull()
    })

    it("round-trips the digest marker, absent until the first write", async () => {
        // See the note on DIGEST_MARKER_KEY: KV is shared across this
        // file's tests, so this starts from a known-clean state.
        await testEnv.records.delete(DIGEST_MARKER_KEY)
        const store = kvSnapshotStore(testEnv)
        expect(await store.getDigestMarker()).toBeNull()
        await store.putDigestMarker({ sealedThrough: 42, oldest: 7 })
        expect(await store.getDigestMarker()).toEqual({ sealedThrough: 42, oldest: 7 })
    })
})
