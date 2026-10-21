import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import { settle, type IngestDeps } from "@germ-network/atproto-pmr-monitor"
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

describe("owed_since_us (S3)", () => {
    it.todo("intake stamps owed_since_us with the event cursor")
    it.todo("a second event for an owed DID keeps the earlier stamp")
    it.todo("a stream identity event stamps; backfill, join and PLC owes do not")
    it.todo("a null-time frame stamps the stored cursor")
    it.todo("migration stamps pre-existing rows 0")
    it.todo("a discharge moves its stamp to applied_recent for KV_VISIBILITY_MS, then prunes it")
    it.todo("an applied_recent row is never re-settled; a new event for that DID re-owes normally")
    it.todo("only held DIDs' rows count")
})

describe("publication (S5)", () => {
    it.todo("the alarm publishes one firehose:coverage value carrying the watermark and lagging list")
    it.todo("over the cap the published coveredThroughMs is null, replacing any older value")
    it.todo("kvFirehoseCoverage reads a missing or malformed entry as null")
})

describe("gap and resync (S6)", () => {
    it.todo("a connect with a cursor past the replay window starts a new run and owes every served declaration DID at the gap instant")
    it.todo("a resync does not re-owe a reversibly gone DID")
    it.todo("a resume whose first frame jumps past the tolerance does the same")
    it.todo("coverage is null until every re-owed DID settles or lags, then resumes from the run start")
})
