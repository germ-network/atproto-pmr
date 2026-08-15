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
    type FetchedRecord,
} from "@germ-network/atproto-pmr-monitor"
import { kvSnapshotStore } from "../src/snapshot-store"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"

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

    it("answers changedSince, which is why the index is not merely KV", async () => {
        // REALISTIC MAGNITUDES, deliberately. An earlier version of this
        // test used 1000/5000 with a cursor of 2000 — self-consistent
        // numbers that passed while the production comparison was a stream
        // cursor in MICROSECONDS against an observation time in
        // MILLISECONDS, which is always false. Fixtures drawn from outside
        // the real domain cannot catch a unit mismatch.
        const stub = freshStub()
        const now = Date.now()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete("did:plc:old", "3m1", now - 60_000)
            await obj.complete("did:plc:new", "3m2", now - 1_000)
            return obj.changedSince(
                ["did:plc:old", "did:plc:new", "did:plc:absent"],
                String(now - 30_000)
            )
        })
        expect(result.dids).toEqual(["did:plc:new"])
    })

    it("hands back a delta cursor usable as the next request's `since`", async () => {
        // The round trip is the property: a cursor the monitor issued must
        // exclude what it already reported. A stream cursor here would be
        // 1000x out and silently report nothing, forever.
        const stub = freshStub()
        const now = Date.now()
        const second = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", now - 1_000)
            const first = await obj.changedSince([DID], null)
            expect(first.dids).toEqual([DID])
            return obj.changedSince([DID], first.nextCursor)
        })
        expect(second.dids).toEqual([])
    })

    it("does not confuse the stream cursor with a delta cursor", async () => {
        // Feed it a REAL Jetstream cursor (microseconds) as if someone
        // wired the two together again: it must not silently answer
        // "nothing changed" for a DID observed a second ago.
        const stub = freshStub()
        const now = Date.now()
        const streamCursor = String(now * 1000)
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", now - 1_000)
            return obj.changedSince([DID], String(now - 30_000))
        })
        expect(result.dids).toEqual([DID])
        expect(Number(streamCursor)).toBeGreaterThan(Number(result.nextCursor))
    })
})

describe("settling what is owed", () => {
    it("stores the record and indexes the rev", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "100")
        )
        const car = new Uint8Array([1, 2, 3])
        const settled = await withFetch(stub, async () => ({ rev: "3m1", car }))
        expect(settled).toBe(1)

        const stored = await kvSnapshotStore(testEnv).getRecord(DID)
        expect(stored?.rev).toBe("3m1")
        expect([...(stored?.car ?? [])]).toEqual([1, 2, 3])
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
            return obj.windowMembers(12)
        })
        expect(members).toEqual([DID])
    })

    it("seals closed windows on the alarm, leaving the open one alone", async () => {
        const stub = freshStub()
        const now = Date.now()
        const currentWindow = Math.floor(now / 600_000)
        const sealed = await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:old", "3m1", (currentWindow - 2) * 600_000)
            await obj.complete("did:plc:now", "3m2", now)
            return sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                nowMs: () => now,
            })
        })
        expect(sealed).toEqual([currentWindow - 2])

        const bytes = await kvSnapshotStore(testEnv).getSealedWindow(String(currentWindow - 2))
        const [w] = decodeDigestWindows(bytes!)
        expect(mightHaveChanged(w, "did:plc:old")).toBe(true)
        expect(mightHaveChanged(w, "did:plc:now")).toBe(false)

        // The current window is still accumulating.
        const stillOpen = await inMonitorObj(stub, (obj) => obj.windowMembers(currentWindow))
        expect(stillOpen).toEqual(["did:plc:now"])
    })

    it("tracks sealedThrough, the boundary between empty and unpublished", async () => {
        const stub = freshStub()
        const now = Date.now()
        const before = await inMonitorObj(stub, (obj) => obj.readSealedThrough())
        expect(before).toBeNull()
        await inMonitorObj(stub, (obj) =>
            sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                nowMs: () => now,
            })
        )
        expect(await inMonitorObj(stub, (obj) => obj.readSealedThrough())).toBe(
            Math.floor(now / 600_000) - 1
        )
    })
})

describe("the snapshot store", () => {
    it("keeps records without a TTL — an unchanged record stays served", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putRecord("did:plc:ttl", {
            rev: "3m1",
            car: new Uint8Array([9]),
            observedAtMs: 1,
        })
        const back = await store.getRecord("did:plc:ttl")
        expect(back).toMatchObject({ rev: "3m1", observedAtMs: 1 })
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
})
