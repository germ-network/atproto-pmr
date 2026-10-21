import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    settleDue,
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
            sql.exec("INSERT INTO interest (did, member) VALUES ('did:plc:held', 1)")
            sql.exec("INSERT INTO interest (did, member) VALUES ('did:plc:member', 1)")
            const { retryCapMs } = depsOf(obj)
            expect(await retryCapMs?.("did:plc:held")).toBe(Number(testEnv.REFRESH_STALE_AFTER_MS))
            expect(await retryCapMs?.("did:plc:member")).toBe(86_400_000)
            expect(await retryCapMs?.("did:plc:other")).toBe(SETTLE_RETRY_CAP_MS)
        })
    })

    async function backedOff(obj: MonitorIngest, sql: SqlStorage, did: string) {
        await obj.owe(did, "3m1")
        sql.exec("UPDATE pending SET owed_at = 5 WHERE did = ?", did)
        await obj.deferPending(did, 9_000_000_000_000, THREW)
        await obj.deferPending(did, 9_000_000_000_000, THREW)
        expect(pendingRow(sql, did)?.attempts).toBe(2)
    }

    it("a firehose intake resets attempts and not_before but keeps owed_at and the last failure", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await backedOff(obj, sql, DID)
            await obj.intake({ did: DID, rev: "3m2" }, "1")
            const row = pendingRow(sql, DID)
            expect(row).toMatchObject({ rev: "3m2", attempts: 0, not_before: 0, owed_at: 5 })
            expect(JSON.parse(row?.last_failure ?? "null")).toEqual(THREW)
        })
    })

    it("an event-driven owe (identity event, PLC key rotation) resets attempts and not_before", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await backedOff(obj, sql, DID)
            await obj.owe(DID, "3m1")
            expect(pendingRow(sql, DID)).toMatchObject({ attempts: 0, not_before: 0, owed_at: 5 })
        })
    })

    it("a quiet deferral to the declaration does not reset an existing row", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await backedOff(obj, sql, DID)
            sql.exec("DELETE FROM revs WHERE did = ?", DID)
            await secondaryDepsOf(obj).deferToDeclaration(DID)
            expect(pendingRow(sql, DID)?.attempts).toBe(2)
            expect(pendingRow(sql, DID)?.not_before).toBe(9_000_000_000_000)
        })
    })

    it("an interest join does not reset an existing row", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await backedOff(obj, sql, DID)
            await obj.oweJoin(DID, [], 0)
            expect(pendingRow(sql, DID)?.attempts).toBe(2)
            expect(pendingRow(sql, DID)?.not_before).toBe(9_000_000_000_000)
        })
    })
})

describe("settle failure log line", () => {
    const PREFIX = "monitor: settle deferred"

    /** Owes `DID`, settles it through the object's real deps, and returns the settle-deferred lines. */
    async function settleLogged(
        stubs: {
            fetchRecord: () => Promise<unknown>
            verifyRecord?: () => Promise<unknown>
        },
        attempts = 0
    ) {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await inObj(freshStub(), async (obj, sql) => {
                const o = obj as unknown as Record<string, unknown>
                o.fetchRecord = stubs.fetchRecord
                if (stubs.verifyRecord !== undefined) o.verifyRecord = stubs.verifyRecord
                await obj.owe(DID, "3m1")
                sql.exec("UPDATE pending SET attempts = ?", attempts)
                await settleDue(depsOf(obj))
            })
            return warn.mock.calls.filter((c) => c[0] === PREFIX).map((c) => c[1] as Record<string, unknown>)
        } finally {
            warn.mockRestore()
        }
    }

    const record = (signingKey: string | null) => async () => ({
        car: new Uint8Array([1]),
        source: "https://pds.example",
        signingKey,
    })

    it("a settle that throws writes one 'monitor: settle deferred' line naming the DID, attempts, error and next not-before", async () => {
        const before = Date.now()
        const lines = await settleLogged(
            {
                fetchRecord: async () => {
                    throw new TypeError("fetch failed")
                },
            },
            2
        )
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
            did: DID,
            attempts: 3,
            kind: "threw",
            error: "TypeError: fetch failed",
        })
        const notBefore = Date.parse(String(lines[0]?.notBefore))
        expect(notBefore).toBeGreaterThanOrEqual(before + 4000)
        expect(notBefore).toBeLessThan(before + 60_000)
    })

    it("a never-held unverifiable DID writes one line of kind unverifiable with its reason", async () => {
        const lines = await settleLogged({
            fetchRecord: record("did:key:zQ3sh"),
            verifyRecord: async () => ({ kind: "unverifiable", reason: "bad commit signature" }),
        })
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
            did: DID,
            attempts: 1,
            kind: "unverifiable",
            reason: "bad commit signature",
        })
    })

    it("a DID with no #atproto signing key is unverifiable with that reason (real verifier, not stubVerify)", async () => {
        const lines = await settleLogged({ fetchRecord: record(null) })
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ kind: "unverifiable", reason: "no #atproto signing key" })
    })

    it("a non-terminal XRPC error is logged with its XRPC error name, e.g. 400 InvalidRequest", async () => {
        const lines = await settleLogged({
            fetchRecord: async () => {
                throw new Error("endpoint answered 400 InvalidRequest")
            },
        })
        expect(String(lines[0]?.error)).toContain("endpoint answered 400 InvalidRequest")
    })

    it("a RecordNotFound settle writes no settle-deferred line", async () => {
        const lines = await settleLogged({
            fetchRecord: async () => {
                throw new RecordNotFoundError("RecordNotFound", false)
            },
        })
        expect(lines).toEqual([])
    })
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
