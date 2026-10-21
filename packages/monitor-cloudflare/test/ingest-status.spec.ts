import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    SETTLE_RETRY_CAP_MS,
    type IngestDeps,
    type PendingFailure,
    type SecondaryDeps,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"

let n = 0
function freshStub(): DurableObjectStub<MonitorIngest> {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`ingest-status-${n}`))
}

function inObj<R>(
    stub: DurableObjectStub<MonitorIngest>,
    fn: (obj: MonitorIngest, sql: SqlStorage) => R | Promise<R>
): Promise<R> {
    return runInDurableObject(stub, (instance, state) =>
        fn(instance as MonitorIngest, state.storage.sql)
    )
}

function depsOf(obj: MonitorIngest): IngestDeps {
    return (obj as unknown as { deps(): IngestDeps }).deps()
}

function secondaryDepsOf(obj: MonitorIngest): SecondaryDeps {
    return (obj as unknown as { secondaryDeps(): SecondaryDeps }).secondaryDeps()
}

interface PendingRaw {
    rev: string
    attempts: number
    not_before: number
    owed_at: number | null
    last_failure: string | null
}

function pendingRow(sql: SqlStorage, did: string): PendingRaw | undefined {
    return sql
        .exec<PendingRaw>(
            "SELECT rev, attempts, not_before, owed_at, last_failure FROM pending WHERE did = ?",
            did
        )
        .toArray()[0]
}

const THREW: PendingFailure = { kind: "threw", errorName: "Error", message: "boom", atMs: 1000 }


describe("pending row bookkeeping", () => {
    it("a new pending row records owed_at from intake, owe and an interest join; a re-owe or re-intake keeps the first owed_at", async () => {
        const stub = freshStub()
        await inObj(stub, async (obj, sql) => {
            const t0 = Date.now()
            await obj.intake({ did: "did:plc:a", rev: "3m1" }, "1")
            await obj.owe("did:plc:b", "3m1")
            await obj.oweJoin("did:plc:c", [], 0)
            await secondaryDepsOf(obj).deferToDeclaration("did:plc:d")
            expect(pendingRow(sql, "did:plc:d")?.owed_at).toBeGreaterThanOrEqual(t0)
            for (const did of ["did:plc:a", "did:plc:b", "did:plc:c"]) {
                const owedAt = pendingRow(sql, did)?.owed_at
                expect(owedAt, did).toBeGreaterThanOrEqual(t0)
            }

            sql.exec("UPDATE pending SET owed_at = 5")
            await obj.intake({ did: "did:plc:a", rev: "3m2" }, "2")
            await obj.owe("did:plc:b", "3m2")
            expect(pendingRow(sql, "did:plc:a")?.owed_at).toBe(5)
            expect(pendingRow(sql, "did:plc:b")?.owed_at).toBe(5)
        })
    })

    it("a pending row created before owed_at existed reads back with owed_at null", async () => {
        const stub = freshStub()
        await inObj(stub, async (_obj, sql) => {
            sql.exec("ALTER TABLE pending DROP COLUMN owed_at")
            sql.exec("ALTER TABLE pending DROP COLUMN last_failure")
            sql.exec("INSERT INTO pending (did, rev) VALUES ('did:plc:old', '3m1')")
        })
        await evictDurableObject(stub)
        await inObj(stub, async (obj, sql) => {
            const row = pendingRow(sql, "did:plc:old")
            expect(row?.owed_at).toBeNull()
            expect(row?.last_failure).toBeNull()
            expect(await obj.deferPending("did:plc:old", 1, THREW)).toBe(1)
        })
    })

    it("deferPending counts the attempt, keeps the failure, and answers the new attempts (null for no row)", async () => {
        const stub = freshStub()
        await inObj(stub, async (obj, sql) => {
            await obj.intake({ did: DID, rev: "3m1" }, "1")
            expect(await obj.deferPending(DID, 500, THREW)).toBe(1)
            const failure: PendingFailure = { kind: "unverifiable", reason: "bad sig", atMs: 2000 }
            expect(await obj.deferPending(DID, 900, failure)).toBe(2)
            const row = pendingRow(sql, DID)
            expect(row?.attempts).toBe(2)
            expect(row?.not_before).toBe(900)
            expect(JSON.parse(row?.last_failure ?? "null")).toEqual(failure)
            expect(await obj.deferPending("did:plc:none", 1, THREW)).toBeNull()
        })
    })
    it("retryCapMs answers the holder interval for a held DID, the non-holder interval for an interest member never held, and SETTLE_RETRY_CAP_MS otherwise", async () => {
        const stub = freshStub()
        await inObj(stub, async (obj, sql) => {
            sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES ('did:plc:held', '3m1', 0)")
            sql.exec("INSERT INTO interest (did, member) VALUES ('did:plc:member', 1)")
            const { retryCapMs } = depsOf(obj)
            expect(await retryCapMs?.("did:plc:held")).toBe(Number(testEnv.REFRESH_STALE_AFTER_MS))
            expect(await retryCapMs?.("did:plc:member")).toBe(86_400_000)
            expect(await retryCapMs?.("did:plc:other")).toBe(SETTLE_RETRY_CAP_MS)
        })
    })

    it.todo("a firehose intake resets attempts and not_before but keeps owed_at and the last failure")
    it.todo("an event-driven owe (identity event, PLC key rotation) resets attempts and not_before")
    it.todo("a quiet deferral to the declaration does not reset an existing row")
    it.todo("an interest join does not reset an existing row")
})

describe("settle failure log line", () => {
    it.todo("a settle that throws writes one 'monitor: settle deferred' line naming the DID, attempts, error and next not-before")
    it.todo("a never-held unverifiable DID writes one line of kind unverifiable with its reason")
    it.todo("a DID with no #atproto signing key is unverifiable with that reason (real verifier, not stubVerify)")
    it.todo("a non-terminal XRPC error is logged with its XRPC error name, e.g. 400 InvalidRequest")
    it.todo("a RecordNotFound settle writes no settle-deferred line")
})

describe("ingestStatus", () => {
    it.todo("reports backfill not started, in progress with its cursor, and done")
    it.todo("reports pending count, due count, max attempts and the attempt buckets against seeded rows")
    it.todo("reports the oldest owed_at and how many rows have none")
    it.todo("reports last-failure counts by kind")
    it.todo("counts held declarations, not gone ones")
    it.todo("carries no DID from pending, holder or rev rows, with a DID-shaped backfill cursor in the fixture")
    it.todo("answers zeros and nulls on empty tables")
})

describe("pendingDetail", () => {
    it.todo("returns the pending row, holder state and indexed rev for an owed DID")
    it.todo("returns all null for a DID the monitor never owed or held")
})

describe("alarm", () => {
    it.todo("logs and carries on to the remaining steps and the re-arm when settleDue throws")
})
