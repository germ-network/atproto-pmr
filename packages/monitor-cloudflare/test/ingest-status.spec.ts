import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    settleDue,
    settleSecondaryDue,
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

    it("alarm-owned join and secondary deferral work continue through final reconciliation", async () => {
        const stub = freshStub()
        const scheduled = await inObj(stub, async (obj, sql) => {
            const joined = "did:plc:join-obligation"
            const deferred = "did:plc:secondary-obligation"
            await obj.oweJoin(joined, [], await obj.interestEpoch(joined))
            await secondaryDepsOf(obj).deferToDeclaration(deferred)
            expect(sql.exec("SELECT 1 FROM meta WHERE k = 'prompt_at'").toArray()).toEqual([])

            await (obj as unknown as { reconcileAlarm(): Promise<void> }).reconcileAlarm()
            const alarmAt = await obj.ctx.storage.getAlarm()
            // The assertion covers continuation registration; do not leave a
            // real 60 s test alarm for Workerd teardown to dispatch.
            await obj.ctx.storage.deleteAlarm()
            return {
                pending: sql.exec<{ did: string }>("SELECT did FROM pending ORDER BY did").toArray().map((r) => r.did),
                promptAt: Number(sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'prompt_at'").one().v),
                alarmAt,
            }
        })
        expect(scheduled.pending).toEqual(["did:plc:join-obligation", "did:plc:secondary-obligation"])
        expect(scheduled.promptAt - Date.now()).toBeGreaterThan(50_000)
        expect(scheduled.alarmAt).toBe(scheduled.promptAt)
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

function seedPending(
    sql: SqlStorage,
    did: string,
    row: { attempts?: number; notBefore?: number; owedAt?: number | null; failure?: PendingFailure | null } = {}
) {
    sql.exec(
        "INSERT INTO pending (did, rev, attempts, not_before, owed_at, last_failure) VALUES (?, '3m1', ?, ?, ?, ?)",
        did,
        row.attempts ?? 0,
        row.notBefore ?? 0,
        row.owedAt === undefined ? 1000 : row.owedAt,
        row.failure ? JSON.stringify(row.failure) : null
    )
}

describe("ingestStatus", () => {
    it("reports backfill not started, in progress with its cursor, and done", async () => {
        await inObj(freshStub(), async (obj) => {
            expect((await obj.ingestStatus()).backfill).toEqual({ done: false, cursor: null })
            await obj.setBackfillProgress({ done: false, cursor: "page-7" })
            expect((await obj.ingestStatus()).backfill).toEqual({ done: false, cursor: "page-7" })
            await obj.setBackfillProgress({ done: true, cursor: null })
            expect((await obj.ingestStatus()).backfill).toEqual({ done: true, cursor: null })
        })
    })

    it("reports pending count, due count, max attempts and the attempt buckets against seeded rows", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            const far = Date.now() + 10 ** 9
            seedPending(sql, "did:plc:a", { attempts: 0 })
            seedPending(sql, "did:plc:b", { attempts: 1, notBefore: Date.now() - 60_000 })
            seedPending(sql, "did:plc:c", { attempts: 3, notBefore: far })
            seedPending(sql, "did:plc:d", { attempts: 5, notBefore: far })
            seedPending(sql, "did:plc:e", { attempts: 20, notBefore: far })
            // workerd holds the clock still between I/O, so this row is due exactly now.
            seedPending(sql, "did:plc:f", { attempts: 2, notBefore: Date.now() })
            const before = Date.now()
            const { pending, asOfMs } = await obj.ingestStatus()
            expect(asOfMs).toBeGreaterThanOrEqual(before)
            expect(pending).toMatchObject({ count: 6, due: 3, maxAttempts: 20 })
            expect(pending.attempts).toEqual([
                { atLeast: 0, count: 1 },
                { atLeast: 1, count: 1 },
                { atLeast: 2, count: 2 },
                { atLeast: 4, count: 1 },
                { atLeast: 8, count: 0 },
                { atLeast: 16, count: 1 },
            ])
        })
    })

    it("reports the oldest owed_at and how many rows have none", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            seedPending(sql, "did:plc:a", { owedAt: 700 })
            seedPending(sql, "did:plc:b", { owedAt: 300 })
            seedPending(sql, "did:plc:e", { owedAt: 500 })
            seedPending(sql, "did:plc:c", { owedAt: null })
            seedPending(sql, "did:plc:d", { owedAt: null })
            const { pending } = await obj.ingestStatus()
            expect(pending.oldestOwedAtMs).toBe(300)
            expect(pending.owedAtUnknown).toBe(2)
        })
    })

    it("reports last-failure counts by kind", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            const unverifiable: PendingFailure = { kind: "unverifiable", reason: null, atMs: 1 }
            seedPending(sql, "did:plc:a", { failure: THREW })
            seedPending(sql, "did:plc:b", { failure: THREW })
            seedPending(sql, "did:plc:c", { failure: unverifiable })
            seedPending(sql, "did:plc:d")
            const { pending } = await obj.ingestStatus()
            expect(pending.lastFailure).toEqual({ threw: 2, unverifiable: 1, none: 1 })
        })
    })

    it("counts held declarations, not gone ones", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            for (const [did, state] of [
                ["did:plc:a", "held"],
                ["did:plc:b", "held"],
                ["did:plc:c", "gone-reversible"],
                ["did:plc:d", "gone-permanent"],
            ]) {
                sql.exec("INSERT INTO holder_state (did, state) VALUES (?, ?)", did, state)
            }
            expect((await obj.ingestStatus()).heldDeclarations).toBe(2)
        })
    })

    it("carries no DID from pending, holder or rev rows, with a DID-shaped backfill cursor in the fixture", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            seedPending(sql, "did:plc:pendingrow", { failure: THREW })
            sql.exec(
                "INSERT INTO rec_pending (did, collection, rkey, rev) VALUES ('did:plc:recrow', 'c', 'r', '3m1')"
            )
            sql.exec("INSERT INTO holder_state (did, state) VALUES ('did:plc:holderrow', 'held')")
            sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES ('did:plc:revrow', '3m1', 0)")
            await obj.setBackfillProgress({ done: false, cursor: "did:plc:cursor" })
            const text = JSON.stringify(await obj.ingestStatus())
            expect(text).toContain("did:plc:cursor")
            for (const did of ["did:plc:pendingrow", "did:plc:recrow", "did:plc:holderrow", "did:plc:revrow"]) {
                expect(text).not.toContain(did)
            }
        })
    })

    it("answers zeros and nulls on empty tables", async () => {
        await inObj(freshStub(), async (obj) => {
            const { pending, secondaryPending, heldDeclarations, gonePermanent } =
                await obj.ingestStatus()
            expect(heldDeclarations).toBe(0)
            expect(gonePermanent).toBe(0)
            expect((await obj.ingestStatus()).followFrameFailures).toEqual({
                count: 0,
                lastAtMs: null,
                lastErrorName: null,
            })
            expect(secondaryPending).toEqual(pending)
            expect(pending).toEqual({
                count: 0,
                due: 0,
                maxAttempts: 0,
                attempts: [0, 1, 2, 4, 8, 16].map((atLeast) => ({ atLeast, count: 0 })),
                oldestOwedAtMs: null,
                owedAtUnknown: 0,
                lastFailure: { threw: 0, unverifiable: 0, none: 0 },
            })
        })
    })
})

describe("pendingDetail", () => {
    it("returns the pending row, holder state and indexed rev for an owed DID", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            seedPending(sql, DID, { attempts: 3, notBefore: 4242, owedAt: 99, failure: THREW })
            sql.exec("UPDATE pending SET quiet = 1")
            sql.exec("INSERT INTO holder_state (did, state) VALUES (?, 'held')", DID)
            sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES (?, '3m0', 0)", DID)
            expect(await obj.pendingDetail(DID)).toEqual({
                did: DID,
                pending: {
                    rev: "3m1",
                    attempts: 3,
                    notBeforeMs: 4242,
                    quiet: true,
                    owedAtMs: 99,
                    lastFailure: THREW,
                },
                holderState: "held",
                indexedRev: "3m0",
            })
        })
    })

    it("returns all null for a DID the monitor never owed or held", async () => {
        await inObj(freshStub(), async (obj) => {
            expect(await obj.pendingDetail("did:plc:never")).toEqual({
                did: "did:plc:never",
                pending: null,
                holderState: null,
                indexedRev: null,
            })
        })
    })
})

describe("alarm", () => {
    it("logs and carries on to the remaining steps and the re-arm when settleDue throws", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inObj(stub, async (obj) => {
            const o = obj as unknown as Record<string, unknown>
            o.duePending = async () => {
                throw new Error("index unavailable")
            }
            const sealing = obj.windowMembers.bind(obj)
            o.windowMembers = async (w: number) => {
                log.push("seal")
                return sealing(w)
            }
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        const original = globalThis.fetch
        globalThis.fetch = (() =>
            Promise.resolve(Response.json({ repos: [] }))) as unknown as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }
        const logged = error.mock.calls.some((c) => c[0] === "monitor: settle failed")
        error.mockRestore()
        expect(logged).toBe(true)
        expect(log).toContain("seal")
        expect(await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())).not.toBeNull()
    })
})

describe("secondary pending bookkeeping", () => {
    const COLLECTION = "app.bsky.actor.profile"
    const RECORD = { collection: COLLECTION, rkey: "self" }

    interface RecRaw {
        rev: string
        attempts: number
        not_before: number
        owed_at: number | null
        last_failure: string | null
    }

    function recRow(sql: SqlStorage, did: string): RecRaw | undefined {
        return sql
            .exec<RecRaw>(
                "SELECT rev, attempts, not_before, owed_at, last_failure FROM rec_pending WHERE did = ?",
                did
            )
            .toArray()[0]
    }

    function member(sql: SqlStorage, did: string) {
        sql.exec("INSERT INTO interest (did, member, epoch) VALUES (?, 1, 1)", did)
    }

    it("rec_pending gains owed_at and last_failure on an existing object; old rows keep NULL", async () => {
        const stub = freshStub()
        await inObj(stub, async (_obj, sql) => {
            sql.exec("ALTER TABLE rec_pending DROP COLUMN owed_at")
            sql.exec("ALTER TABLE rec_pending DROP COLUMN last_failure")
            sql.exec(
                "INSERT INTO rec_pending (did, collection, rkey, rev, epoch) VALUES (?, ?, 'self', '3m1', 1)",
                "did:plc:old",
                COLLECTION
            )
        })
        await evictDurableObject(stub)
        await inObj(stub, async (obj, sql) => {
            const row = recRow(sql, "did:plc:old")
            expect(row?.owed_at).toBeNull()
            expect(row?.last_failure).toBeNull()
            expect(
                await obj.deferSecondary({ did: "did:plc:old", ...RECORD }, 1, THREW)
            ).toBe(1)
        })
    })

    it("oweSecondary and oweJoin stamp owed_at on insert and keep the first stamp on conflict", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            const t0 = Date.now()
            member(sql, "did:plc:a")
            member(sql, "did:plc:b")
            await obj.oweSecondary({ did: "did:plc:a", ...RECORD, rev: "3m1" }, "1")
            await obj.oweJoin("did:plc:b", [RECORD], 1)
            for (const did of ["did:plc:a", "did:plc:b"]) {
                expect(recRow(sql, did)?.owed_at, did).toBeGreaterThanOrEqual(t0)
            }
            sql.exec("UPDATE rec_pending SET owed_at = 5")
            await obj.oweSecondary({ did: "did:plc:a", ...RECORD, rev: "3m2" }, "2")
            await obj.oweJoin("did:plc:b", [RECORD], 1)
            expect(recRow(sql, "did:plc:a")?.owed_at).toBe(5)
            expect(recRow(sql, "did:plc:b")?.owed_at).toBe(5)
        })
    })

    it("a new commit on an owed secondary resets attempts and not_before; a join does not", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            member(sql, DID)
            await obj.oweSecondary({ did: DID, ...RECORD, rev: "3m1" }, "1")
            const backOff = async () => {
                await obj.deferSecondary({ did: DID, ...RECORD }, 9_000_000_000_000, THREW)
                await obj.deferSecondary({ did: DID, ...RECORD }, 9_000_000_000_000, THREW)
            }
            await backOff()
            await obj.oweJoin(DID, [RECORD], 1)
            expect(recRow(sql, DID)).toMatchObject({ attempts: 2, not_before: 9_000_000_000_000 })

            await obj.oweSecondary({ did: DID, ...RECORD, rev: "3m2" }, "2")
            const row = recRow(sql, DID)
            expect(row).toMatchObject({ rev: "3m2", attempts: 0, not_before: 0 })
            expect(JSON.parse(row?.last_failure ?? "null")).toEqual(THREW)
        })
    })

    async function settleFailing(sql: SqlStorage, obj: MonitorIngest, did: string, attempts = 0) {
        member(sql, did)
        await obj.oweSecondary({ did, ...RECORD, rev: "3m1" }, "1")
        sql.exec("UPDATE rec_pending SET attempts = ?", attempts)
        ;(obj as unknown as Record<string, unknown>).fetchRecordAt = async () => {
            throw new TypeError("fetch failed")
        }
        return settleSecondaryDue(secondaryDepsOf(obj))
    }

    it("a throwing secondary settle leaves last_failure on the row and logs 'monitor: secondary settle deferred' with did, collection, rkey, attempts, error, notBefore", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            const before = Date.now()
            await inObj(freshStub(), async (obj, sql) => {
                expect(await settleFailing(sql, obj, DID, 2)).toBe(0)
                const row = recRow(sql, DID)
                expect(row?.attempts).toBe(3)
                expect(JSON.parse(row?.last_failure ?? "null")).toMatchObject({
                    kind: "threw",
                    errorName: "TypeError",
                    message: "fetch failed",
                })
                const lines = warn.mock.calls.filter(
                    (c) => c[0] === "monitor: secondary settle deferred"
                )
                expect(lines).toHaveLength(1)
                expect(lines[0]?.[1]).toMatchObject({
                    did: DID,
                    collection: COLLECTION,
                    rkey: "self",
                    attempts: 3,
                    kind: "threw",
                    error: "TypeError: fetch failed",
                })
                const notBefore = Date.parse(String((lines[0]?.[1] as { notBefore: string }).notBefore))
                expect(notBefore).toBeGreaterThanOrEqual(before + 4000)
                expect(notBefore).toBe(row?.not_before)
            })
        } finally {
            warn.mockRestore()
        }
    })

    it("a secondary retry waits no longer than the DID's refresh interval", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await inObj(freshStub(), async (obj, sql) => {
                sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES (?, '3m0', 0)", DID)
                const before = Date.now()
                await settleFailing(sql, obj, DID, 30)
                const waited = (recRow(sql, DID)?.not_before ?? 0) - before
                expect(waited).toBeGreaterThan(0)
                expect(waited).toBeLessThanOrEqual(Number(testEnv.REFRESH_STALE_AFTER_MS ?? 3_600_000) + 1000)
            })
        } finally {
            warn.mockRestore()
        }
    })
})

describe("ingestStatus secondary and gone counts", () => {
    it("secondaryPending summarises rec_pending in PendingSummary's shape and counts a failed settle as threw", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await inObj(freshStub(), async (obj, sql) => {
                sql.exec("INSERT INTO interest (did, member, epoch) VALUES (?, 1, 1)", DID)
                await obj.oweSecondary(
                    { did: DID, collection: "app.bsky.actor.profile", rkey: "self", rev: "3m1" },
                    "1"
                )
                sql.exec("UPDATE rec_pending SET owed_at = 77")
                ;(obj as unknown as Record<string, unknown>).fetchRecordAt = async () => {
                    throw new TypeError("fetch failed")
                }
                await settleSecondaryDue(secondaryDepsOf(obj))
                const status = await obj.ingestStatus()
                expect(status.secondaryPending).toMatchObject({
                    count: 1,
                    due: 0,
                    maxAttempts: 1,
                    oldestOwedAtMs: 77,
                    owedAtUnknown: 0,
                    lastFailure: { threw: 1, unverifiable: 0, none: 0 },
                })
                expect(status.secondaryPending.attempts.find((b) => b.atLeast === 1)?.count).toBe(1)
                expect(status.pending.count).toBe(0)
            })
        } finally {
            warn.mockRestore()
        }
    })
    it("gonePermanent counts gone-permanent holders only", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            for (const [did, state] of [
                ["did:plc:a", "held"],
                ["did:plc:b", "gone-reversible"],
                ["did:plc:c", "gone-permanent"],
                ["did:plc:d", "gone-permanent"],
            ]) {
                sql.exec("INSERT INTO holder_state (did, state) VALUES (?, ?)", did, state)
            }
            const status = await obj.ingestStatus()
            expect(status.gonePermanent).toBe(2)
            expect(status.heldDeclarations).toBe(1)
        })
    })
})
