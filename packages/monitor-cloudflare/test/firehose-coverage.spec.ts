import {
    env,
    evictDurableObject,
    runDurableObjectAlarm,
    runInDurableObject,
} from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    FIREHOSE_LAGGING_CAP,
    KV_VISIBILITY_MS,
    RecordNotFoundError,
} from "@germ-network/atproto-pmr-core"
import { intake, settle, type IngestDeps } from "@germ-network/atproto-pmr-monitor"
import { FIREHOSE_COVERAGE_KEY, kvFirehoseCoverage } from "../src/firehose-coverage-store"
import { kvSnapshotStore } from "../src/snapshot-store"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

let n = 0
function freshStub(): DurableObjectStub<MonitorIngest> {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`coverage-${n}`))
}

type StubFetched = Awaited<ReturnType<IngestDeps["fetchRecord"]>> & { rev: string }

const stubVerify: IngestDeps["verify"] = async (_did, record) => ({
    kind: "verified",
    key: SIGNING_KEY,
    rev: (record as StubFetched).rev,
    cid: "bafyreistub",
})

/** One settle of `DID` whose fetch runs `during` first: what the stream does mid-fetch. */
function settleWhile(
    obj: MonitorIngest,
    fetched: (obj: MonitorIngest) => Promise<StubFetched>,
    during: (obj: MonitorIngest) => Promise<void>,
    opts: { quiet?: boolean } = {}
) {
    return settle(
        {
            index: obj,
            interest: obj,
            snapshot: kvSnapshotStore(testEnv),
            fetchRecord: async () => {
                await during(obj)
                return fetched(obj)
            },
            verify: stubVerify,
            nowMs: () => Date.now(),
        },
        DID,
        opts
    )
}

const record = (rev: string): StubFetched => ({
    rev,
    car: new Uint8Array([1]),
    source: PDS,
    signingKey: SIGNING_KEY,
})

async function owedRevs(obj: MonitorIngest): Promise<string[]> {
    return (await obj.duePending(Date.now(), 10)).map((p) => p.rev)
}

describe("owe generation (S2)", () => {
    it("an event owed during a fetch survives that fetch's complete", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            const outcome = await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => void (await o.intake({ did: DID, rev: "3m2" }, "200"))
            )
            return { outcome, owed: await owedRevs(obj) }
        })
        expect(owed).toEqual({ outcome: "stored", owed: ["3m2"] })
    })

    it("an event owed during a fetch survives that fetch's completeDeletion and clearPending", async () => {
        const deleted = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            const outcome = await settleWhile(
                obj,
                async () => {
                    throw new RecordNotFoundError("gone", false, "RecordNotFound")
                },
                async (o) => void (await o.intake({ did: DID, rev: "3m2" }, "200"))
            )
            return { outcome, owed: await owedRevs(obj) }
        })
        expect(deleted).toEqual({ outcome: "deleted", owed: ["3m2"] })

        const regressed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m9", Date.now(), {
                cid: "bafyreistub",
                verifiedWith: SIGNING_KEY,
            })
            await obj.intake({ did: DID, rev: "3m10" }, "100")
            const outcome = await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => void (await o.intake({ did: DID, rev: "3m11" }, "200"))
            )
            return { outcome, owed: await owedRevs(obj) }
        })
        expect(regressed).toEqual({ outcome: "rejected", owed: ["3m11"] })
    })

    it("an identity event owed during a fetch survives it", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), {
                cid: "bafyreistub",
                verifiedWith: SIGNING_KEY,
            })
            await obj.owe(DID, "3m1")
            await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => o.owe(DID, "3m1")
            )
            return owedRevs(obj)
        })
        expect(owed).toEqual(["3m1"])
    })

    it("a join obligation's quiet settle leaves an event owed during it", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
                "INSERT INTO pending (did, rev, attempts, not_before, quiet) VALUES (?, '', 0, 0, 1)",
                DID
            )
            await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => void (await o.intake({ did: DID, rev: "3m2" }, "200")),
                { quiet: true }
            )
            return (await obj.duePending(Date.now(), 10)).map((p) => [p.rev, p.quiet])
        })
        expect(owed).toEqual([["3m2", false]])
    })

    it("a settle that started with nothing owed leaves an event owed during it", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => void (await o.intake({ did: DID, rev: "3m2" }, "200"))
            )
            return owedRevs(obj)
        })
        expect(owed).toEqual(["3m2"])
    })

    it("a generation is never reused after a row is discharged and owed again", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await settleWhile(
                obj,
                async () => record("3m1"),
                async (o) => {
                    await o.clearPending(DID)
                    await o.intake({ did: DID, rev: "3m2" }, "200")
                }
            )
            return owedRevs(obj)
        })
        expect(owed).toEqual(["3m2"])
    })
})

const VERIFIED = { cid: "bafyreistub", verifiedWith: SIGNING_KEY }

function stampOf(obj: MonitorIngest, did = DID): number | null | undefined {
    const row = (obj as unknown as { db: DurableObjectStorage }).db.sql
        .exec<{ owed_since_us: number | null }>(
            "SELECT owed_since_us FROM pending WHERE did = ?",
            did
        )
        .toArray()[0]
    return row === undefined ? undefined : row.owed_since_us
}

describe("owed_since_us (S3)", () => {
    it("intake stamps owed_since_us with the event cursor", async () => {
        const stamp = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "1700000000000000")
            return stampOf(obj)
        })
        expect(stamp).toBe(1_700_000_000_000_000)
    })

    it("a second event for an owed DID keeps the earlier stamp", async () => {
        const stamps = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "2000")
            await obj.intake({ did: DID, rev: "3m2" }, "3000")
            const later = stampOf(obj)
            await obj.owe(DID, "3m2", 1000)
            return [later, stampOf(obj)]
        })
        expect(stamps).toEqual([2000, 1000])
    })

    it("a stream identity event stamps; a plain owe and a join do not, and a later stream event stamps their row", async () => {
        const stamps = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), VERIFIED)
            await intake(
                (obj as unknown as { deps(): IngestDeps }).deps(),
                { collection: testEnv.MONITOR_COLLECTION, policy: "everyone" },
                {
                    kind: "identity",
                    did: DID,
                    seq: null,
                    timeMs: 5,
                    active: null,
                    status: null,
                },
                "5000"
            )
            const identity = stampOf(obj)
            await obj.owe(DID, "3m1")
            const keptByPlainOwe = stampOf(obj)
            await obj.clearPending(DID)
            await obj.owe(DID, "3m1")
            const plain = stampOf(obj)
            await obj.oweJoin("did:plc:joiner", [], await obj.interestEpoch("did:plc:joiner"))
            const join = stampOf(obj, "did:plc:joiner")
            await obj.intake({ did: "did:plc:joiner", rev: "3m1" }, "9000")
            return [identity, keptByPlainOwe, plain, join, stampOf(obj, "did:plc:joiner")]
        })
        expect(stamps).toEqual([5000, 5000, null, null, 9000])
    })

    it("a null-time frame stamps the stored cursor", async () => {
        const stamp = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), VERIFIED)
            await obj.intake({ did: "did:plc:other", rev: "3m1" }, "7777")
            await (
                obj as unknown as { onFrame(raw: string): Promise<void> }
            ).onFrame(JSON.stringify({ payload: { $type: "#identity", did: DID } }))
            return stampOf(obj)
        })
        expect(stamp).toBe(7777)
    })

    it("migration stamps pre-existing rows 0", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            const sql = (obj as unknown as { db: DurableObjectStorage }).db.sql
            sql.exec("ALTER TABLE pending DROP COLUMN owed_since_us")
            sql.exec(
                "INSERT INTO pending (did, rev, attempts, not_before, owed_gen) VALUES (?, '3m1', 0, 0, 0)",
                DID
            )
        })
        await evictDurableObject(stub)
        const stamp = await runInDurableObject(stub, async (obj: MonitorIngest) => stampOf(obj))
        expect(stamp).toBe(0)
    })

    it("a discharge moves its stamp to applied_recent for KV_VISIBILITY_MS, then prunes it", async () => {
        const seen = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "4000")
            await obj.complete(DID, "3m1", Date.now(), VERIFIED, await obj.owedGenOf(DID))
            const now = Date.now()
            return {
                pending: stampOf(obj),
                within: await obj.owedStreamEvents(now),
                after: await obj.owedStreamEvents(now + KV_VISIBILITY_MS + 1),
            }
        })
        expect(seen.pending).toBeUndefined()
        expect(seen.within).toEqual([
            { did: DID, owedSinceUs: 4000, appliedAtMs: expect.any(Number) },
        ])
        expect(seen.after).toEqual([])
    })

    it("an applied_recent row is never re-settled; a new event for that DID re-owes normally", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "4000")
            await obj.complete(DID, "3m1", Date.now(), VERIFIED)
            const idle = (await obj.duePending(Date.now(), 10)).length
            await obj.intake({ did: DID, rev: "3m2" }, "6000")
            const events = await obj.owedStreamEvents(Date.now())
            return { idle, due: await owedRevs(obj), events }
        })
        expect(owed.idle).toBe(0)
        expect(owed.due).toEqual(["3m2"])
        expect(owed.events.map((e) => [e.owedSinceUs, e.appliedAtMs === null])).toEqual([
            [6000, true],
            [4000, false],
        ])
    })

    it("a gone DID's applied fetch still counts for the visibility window", async () => {
        const events = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), VERIFIED)
            await obj.intake({ did: DID, rev: "3m2" }, "4000")
            await obj.completeDeletion(
                DID,
                Date.now(),
                false,
                false,
                "repo",
                await obj.owedGenOf(DID)
            )
            return obj.owedStreamEvents(Date.now())
        })
        expect(events).toEqual([
            { did: DID, owedSinceUs: 4000, appliedAtMs: expect.any(Number) },
        ])
    })

    it("only held DIDs' rows count", async () => {
        const events = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.intake({ did: "did:plc:never", rev: "3m1" }, "4000")
            await obj.complete(DID, "3m1", Date.now(), VERIFIED)
            await obj.intake({ did: DID, rev: "3m2" }, "5000")
            return obj.owedStreamEvents(Date.now())
        })
        expect(events.map((e) => e.did)).toEqual([DID])
    })
})

const NOW = 1_700_000_000_000

async function published(): Promise<unknown> {
    return JSON.parse((await testEnv.records.get(FIREHOSE_COVERAGE_KEY)) ?? "null")
}

describe("publication (S5)", () => {
    it("the alarm publishes one firehose:coverage value carrying the watermark and lagging list", async () => {
        const stub = freshStub()
        const now = Date.now()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", now, VERIFIED)
            await obj.complete("did:plc:old", "3m1", now, VERIFIED)
            await obj.intake({ did: "did:plc:old", rev: "3m2" }, String((now - 30 * 60_000) * 1000))
            await obj.intake({ did: DID, rev: "3m2" }, String((now - 2000) * 1000))
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
            const set = (obj as unknown as { setMeta(k: string, v: string): void }).setMeta
            set.call(obj, "firehose_since", String(now - 3_600_000))
        })
        const original = globalThis.fetch
        globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }
        const value = (await published()) as { coveredThroughMs: number; lagging: string[] }
        expect(value.lagging).toEqual(["did:plc:old"])
        expect(value.coveredThroughMs).toBe(now - 2000)
    })

    it("over the cap the published coveredThroughMs is null, replacing any older value", async () => {
        const out = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const sql = (obj as unknown as { db: DurableObjectStorage }).db.sql
            await obj.intake({ did: DID, rev: "3m1" }, String((NOW - 1000) * 1000))
            const first = await obj.publishFirehoseCoverage(NOW)
            for (let i = 0; i <= FIREHOSE_LAGGING_CAP; i++) {
                const did = `did:plc:lag${i}`
                sql.exec("INSERT INTO holder_state (did, state) VALUES (?, 'held')", did)
                sql.exec(
                    "INSERT INTO pending (did, rev, owed_since_us) VALUES (?, '3m1', 0)",
                    did
                )
            }
            const second = await obj.publishFirehoseCoverage(NOW)
            return { first, second }
        })
        expect(out.first.coveredThroughMs).toBeNull()
        const stored = (await published()) as { coveredThroughMs: number | null; lagging: string[] }
        expect(stored.coveredThroughMs).toBeNull()
        expect(stored.lagging).toHaveLength(FIREHOSE_LAGGING_CAP + 1)
    })

    it("publishes a watermark once the cursor passes the run start", async () => {
        const coverage = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            await obj.publishFirehoseCoverage(NOW)
            await obj.intake({ did: DID, rev: "3m1" }, String((NOW + 5000) * 1000))
            return obj.publishFirehoseCoverage(NOW + 6000)
        })
        expect(coverage).toEqual({
            continuousSinceMs: NOW,
            coveredThroughMs: NOW + 5000,
            lagging: [],
        })
    })

    it("kvFirehoseCoverage reads a missing or malformed entry as null", async () => {
        const read = kvFirehoseCoverage(testEnv)
        await testEnv.records.delete(FIREHOSE_COVERAGE_KEY)
        expect(await read()).toBeNull()
        for (const bad of [
            "nope",
            "[]",
            '{"continuousSinceMs":"1","coveredThroughMs":2,"lagging":[]}',
            '{"continuousSinceMs":1,"coveredThroughMs":"2","lagging":[]}',
            '{"continuousSinceMs":1,"coveredThroughMs":2,"lagging":[1]}',
            '{"continuousSinceMs":1,"coveredThroughMs":2}',
        ]) {
            await testEnv.records.put(FIREHOSE_COVERAGE_KEY, bad)
            expect(await read()).toBeNull()
        }
        await testEnv.records.put(
            FIREHOSE_COVERAGE_KEY,
            '{"continuousSinceMs":1,"coveredThroughMs":null,"lagging":["did:plc:a"]}'
        )
        expect(await read()).toEqual({
            continuousSinceMs: 1,
            coveredThroughMs: null,
            lagging: ["did:plc:a"],
        })
    })
})

const HOUR = 3_600_000

type Internals = {
    db: DurableObjectStorage
    connect(): Promise<void>
    onFrame(raw: string): Promise<void>
    metaOf(k: string): string | undefined
}

/** Connect with the stored cursor, so gap checks run; the upgrade itself fails. */
async function connectOnce(obj: MonitorIngest): Promise<void> {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("no stream"))) as typeof fetch
    try {
        await (obj as unknown as Internals).connect()
    } catch {
        // No real socket to open here.
    } finally {
        globalThis.fetch = original
    }
}

async function holdTwo(obj: MonitorIngest, at: number) {
    await obj.complete(DID, "3m1", at, VERIFIED)
    await obj.complete("did:plc:bob", "3m1", at, VERIFIED)
}

const owedStamps = (obj: MonitorIngest) =>
    (obj as unknown as Internals).db.sql
        .exec<{ did: string; owed_since_us: number }>(
            "SELECT did, owed_since_us FROM pending ORDER BY did"
        )
        .toArray()

describe("gap and resync (S6)", () => {
    it("a connect with a cursor past the replay window starts a new run and owes every served declaration DID at the gap instant, on every attempt", async () => {
        const result = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const now = Date.now()
            await holdTwo(obj, now)
            await obj.intake({ did: "did:plc:cursor", rev: "3m1" }, String((now - 48 * HOUR) * 1000))
            await obj.clearPending("did:plc:cursor")
            await connectOnce(obj)
            const first = owedStamps(obj)
            await obj.clearPending(DID)
            await obj.clearPending("did:plc:bob")
            await connectOnce(obj)
            return {
                now,
                first,
                since: Number((obj as unknown as Internals).metaOf("firehose_since")),
                again: owedStamps(obj),
            }
        })
        expect(result.first.map((r) => r.did)).toEqual([DID, "did:plc:bob"])
        for (const r of result.first) {
            expect(r.owed_since_us / 1000).toBeGreaterThanOrEqual(result.now - 1)
            expect(r.owed_since_us / 1000).toBeLessThan(result.since)
        }
        expect(result.since).toBeGreaterThanOrEqual(result.now)
        expect(result.again.map((r) => r.did)).toEqual([DID, "did:plc:bob"])
    })

    it("a resync does not re-owe a reversibly gone DID", async () => {
        const owed = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const now = Date.now()
            await holdTwo(obj, now)
            await obj.completeDeletion("did:plc:bob", now, false, false, "repo")
            await obj.intake({ did: "did:plc:cursor", rev: "3m1" }, String((now - 48 * HOUR) * 1000))
            await obj.clearPending("did:plc:cursor")
            await connectOnce(obj)
            return owedStamps(obj).map((r) => r.did)
        })
        expect(owed).toEqual([DID])
    })

    it("a resume whose first frame jumps past the tolerance does the same", async () => {
        const out = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const now = Date.now()
            await holdTwo(obj, now)
            const cursorMs = now - 10 * 60_000
            await obj.intake({ did: "did:plc:cursor", rev: "3m1" }, String(cursorMs * 1000))
            await obj.clearPending("did:plc:cursor")
            await connectOnce(obj)
            const frame = (timeMs: number) =>
                JSON.stringify({
                    payload: { $type: "#identity", did: "did:plc:nobody", time_us: timeMs * 1000 },
                })
            const o = obj as unknown as Internals
            await o.onFrame(frame(cursorMs + 30_000))
            const withinTolerance = owedStamps(obj).length
            await connectOnce(obj)
            await o.onFrame(frame(cursorMs + 5 * 60_000))
            return { withinTolerance, owed: owedStamps(obj).map((r) => r.did), now }
        })
        expect(out.withinTolerance).toBe(0)
        expect(out.owed).toEqual([DID, "did:plc:bob"])
    })

    it("coverage is null until every re-owed DID settles or lags, then resumes from the run start", async () => {
        const out = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const now = Date.now()
            await holdTwo(obj, now)
            await obj.intake({ did: "did:plc:cursor", rev: "3m1" }, String((now - 48 * HOUR) * 1000))
            await obj.clearPending("did:plc:cursor")
            await connectOnce(obj)
            const since = Number((obj as unknown as Internals).metaOf("firehose_since"))
            const live = async (ms: number) =>
                (obj as unknown as Internals).db.sql.exec(
                    "INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                    String(ms * 1000)
                )
            await live(since + 1000)
            const owedNow = await obj.publishFirehoseCoverage(since + 2000)
            for (const did of [DID, "did:plc:bob"]) {
                await obj.complete(did, "3m1", since, VERIFIED, await obj.owedGenOf(did))
            }
            const held = await obj.publishFirehoseCoverage(since + 2000)
            await live(since + 70_000)
            const settled = await obj.publishFirehoseCoverage(since + 70_000)
            await live(since + 11 * 60_000)
            const lagged = await (async () => {
                for (const did of [DID, "did:plc:bob"]) await obj.owe(did, "3m1", (since - 1) * 1000)
                return obj.publishFirehoseCoverage(since + 11 * 60_000)
            })()
            return { since, owedNow, held, settled, lagged }
        })
        expect(out.owedNow.coveredThroughMs).toBeNull()
        expect(out.held.coveredThroughMs).toBeNull()
        expect(out.settled.coveredThroughMs).toBe(out.since + 70_000)
        expect(out.lagged.lagging).toEqual([DID, "did:plc:bob"])
        expect(out.lagged.coveredThroughMs).toBe(out.since + 11 * 60_000)
    })
})
