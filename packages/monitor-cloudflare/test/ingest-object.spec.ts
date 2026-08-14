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
import { settleDue, type FetchedRecord } from "@germ-network/atproto-pmr-monitor"
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
        const stub = freshStub()
        const changed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete("did:plc:old", "3m1", 1_000)
            await obj.complete("did:plc:new", "3m2", 5_000)
            return obj.changedSince(["did:plc:old", "did:plc:new", "did:plc:absent"], "2000")
        })
        expect(changed).toEqual(["did:plc:new"])
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
