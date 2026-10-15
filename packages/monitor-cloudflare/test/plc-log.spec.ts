/**
 * The ingest object keeps a log for every kept did:plc DID, extends it from
 * the stream, owes a fetch whenever the log may be missing operations, and
 * publishes it for the DID-document route.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FETCH_AS_OF_SKEW_MS } from "@germ-network/atproto-pmr-monitor"
import modern from "../../core/test/fixtures/plc-log-modern.json"
import { logEntry, signedOperation, syntheticPlcChain } from "../../core/test/fixtures/plc-chain"
import { makeKey } from "../../core/test/fixtures/repo-car"
import { canonicalDidDocumentJson, PLC_LOG_PREFIX, kvPlcLogs } from "../src/did-document-store"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv
const VERIFIED = { cid: "bafyreistub", verifiedWith: "zKey" }

let n = 0
const stub = () => {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`plc-log-${n}`))
}
const inObj = <R>(
    s: DurableObjectStub<MonitorIngest>,
    fn: (obj: MonitorIngest, sql: SqlStorage) => Promise<R>
) => runInDurableObject(s, (obj, state) => fn(obj as MonitorIngest, state.storage.sql))

afterEach(() => vi.restoreAllMocks())

const synthetic = syntheticPlcChain

/** Make `did` a held, watched DID (everyone policy) that has joined. */
async function join(obj: MonitorIngest, did: string): Promise<void> {
    await obj.complete(did, "3m1", Date.now(), VERIFIED)
    await obj.oweJoin(did, [], await obj.interestEpoch(did))
}

const logRows = (sql: SqlStorage) =>
    sql
        .exec<{
            did: string
            log: string | null
            version: number
            published_version: number | null
            owed_at: number | null
            attempted_at: number
        }>("SELECT did, log, version, published_version, owed_at, attempted_at FROM plc_logs ORDER BY did")
        .toArray()
const kvLog = async (did: string) => kvPlcLogs(testEnv).get(did)

describe("MonitorIngest PLC logs", () => {
    it("a DID joining the kept set is owed a log fetch", async () => {
        await inObj(stub(), async (obj) => {
            const { did } = synthetic()
            await join(obj, did)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([did])
            // A did:web DID is not owed one.
            await join(obj, "did:web:example.com")
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([did])
        })
    })

    it("a stream operation that chains is appended and republished", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await join(obj, s.did)
            const fetchedAt = Date.now() + 1000
            await obj.putPlcLog(s.log([s.g], fetchedAt))
            expect((await obj.publishPlcLogs(10)).published).toBe(1)
            expect((await kvLog(s.did))!.entries).toHaveLength(1)

            const second = s.next(s.g.cid, "b")
            await obj.intakePlcLogEntry(s.did, second)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([])
            expect((await obj.publishPlcLogs(10)).published).toBe(1)
            const out = (await kvLog(s.did))!
            expect(out.entries.map((e) => e.cid)).toEqual([s.g.cid, second.cid])
            // Never moves back before the fetch it extends.
            expect(out.asOfMs).toBe(Math.max(fetchedAt, second.createdAtMs))
            // A replayed operation changes nothing.
            const before = logRows(sql)[0]!.version
            await obj.intakePlcLogEntry(s.did, second)
            expect(logRows(sql)[0]!.version).toBe(before)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([])
        })
    })

    it("a stream operation that does not chain, or with no log held, owes a fetch", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            const second = s.next(s.g.cid, "b")
            // No log held yet: still owed from the join, and the entry is not kept.
            await obj.intakePlcLogEntry(s.did, second)
            await obj.putPlcLog(s.log([s.g]))
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([])
            const stray = s.next("bafyreinowhere", "z")
            await obj.intakePlcLogEntry(s.did, stray)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([s.did])
            // The held log did not change.
            await obj.publishPlcLogs(10)
            expect((await kvLog(s.did))!.entries).toHaveLength(1)
        })
    })

    it("an operation for a DID whose document is not kept, or that is not watched, is ignored", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await obj.intakePlcLogEntry(s.did, s.g)
            await obj.owePlcLog(s.did, Date.now())
            await obj.putPlcLog(s.log([s.g]))
            expect(logRows(sql)).toEqual([])
            // A DID confirmed deleted is no longer kept.
            const gone = synthetic()
            await join(obj, gone.did)
            await obj.completeDeletion(gone.did, Date.now(), true)
            // The deletion itself ends the debt.
            expect(logRows(sql).filter((r) => r.did === gone.did)).toEqual([])
            await obj.intakePlcLogEntry(gone.did, gone.next(gone.g.cid, "b"))
            await obj.putPlcLog(gone.log([gone.g]))
            expect(logRows(sql).filter((r) => r.log !== null)).toEqual([])
            // And owes no fetch: it would be repeated every alarm.
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([])
            expect(logRows(sql).filter((r) => r.did === gone.did)).toEqual([])
        })
    })

    it("a DID that stopped being watched has its debt dropped when its fetch lands", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await join(obj, s.did)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([s.did])
            sql.exec("DELETE FROM interest WHERE did = ?", s.did)
            sql.exec("DELETE FROM revs WHERE did = ?", s.did)
            await obj.putPlcLog(s.log([s.g]))
            expect(logRows(sql)).toEqual([])
        })
    })

    it("a recovery operation that forks from before the tail owes a fetch and leaves the held log alone", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.putPlcLog(s.log([s.g], Date.now() + 1000))
            await obj.intakePlcLogEntry(s.did, s.next(s.g.cid, "b"))
            expect(await obj.owedPlcLogs(Date.now() + 5000, 10)).toEqual([])
            await obj.intakePlcLogEntry(s.did, s.next(s.g.cid, "fork"))
            expect(await obj.owedPlcLogs(Date.now() + 5000, 10)).toEqual([s.did])
            await obj.publishPlcLogs(10)
            expect((await kvLog(s.did))!.entries).toHaveLength(2)
        })
    })

    it("an operation not signed by a rotation key of the held tail is not appended", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.putPlcLog(s.log([s.g], Date.now() + 1000))
            const { sig: _sig, ...unsigned } = s.g.operation
            const forged = logEntry(
                signedOperation(makeKey(), { ...unsigned, prev: s.g.cid, alsoKnownAs: ["at://x.test"] })
            )
            await obj.intakePlcLogEntry(s.did, forged)
            expect(await obj.owedPlcLogs(Date.now() + 5000, 10)).toEqual([s.did])
            await obj.publishPlcLogs(10)
            expect((await kvLog(s.did))!.entries).toHaveLength(1)
        })
    })

    it("putPlcLog refuses a log that does not verify", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await join(obj, s.did)
            const second = s.next(s.g.cid, "b")
            const forged = { ...second, operation: { ...second.operation, sig: s.g.operation.sig } }
            await expect(obj.putPlcLog(s.log([s.g, forged]))).rejects.toThrow(/did:plc log/)
            expect(logRows(sql).filter((r) => r.log !== null)).toEqual([])
            expect(sql.exec("SELECT 1 FROM did_documents WHERE did = ?", s.did).toArray()).toEqual([])
        })
    })

    it("a fetch that started before a stream operation does not overwrite the log that has it", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            const t0 = Date.now() + 10_000
            await obj.putPlcLog(s.log([s.g], t0))
            const second = s.next(s.g.cid, "b")
            await obj.intakePlcLogEntry(s.did, { ...second, createdAtMs: t0 + 5000 })
            // A fetch that began at t0 + 1 and missed the operation.
            await obj.putPlcLog(s.log([s.g], t0 + 1))
            await obj.publishPlcLogs(10)
            expect((await kvLog(s.did))!.entries).toHaveLength(2)
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([s.did])
        })
    })

    it("a DID that leaves while its log is being published leaves no plclog: entry", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.putPlcLog(s.log([s.g]))
            const realPut = testEnv.records.put.bind(testEnv.records)
            vi.spyOn(testEnv.records, "put").mockImplementation(async (key, value, options) => {
                await obj.forgetLeft(s.did)
                return realPut(key, value as string, options)
            })
            await obj.publishPlcLogs(10)
            vi.restoreAllMocks()
            expect(await testEnv.records.get(PLC_LOG_PREFIX + s.did)).toBeNull()
        })
    })

    it("a coverage restart owes a fetch for every held log", async () => {
        await inObj(stub(), async (obj) => {
            const [a, b] = [synthetic(), synthetic()]
            for (const s of [a, b]) {
                await join(obj, s.did)
                await obj.putPlcLog(s.log([s.g]))
            }
            await join(obj, "did:plc:nolog00000000000000000")
            await obj.markPlcLogAttempted("did:plc:nolog00000000000000000", 0)
            // The first frames start the run (nothing held was owed before them).
            await obj.advancePlcCursor(1, Date.now() - 5000)
            const owedAfterStart = await obj.owedPlcLogs(Date.now() + 1, 10)
            await obj.resetPlcCursor()
            expect(owedAfterStart).toEqual(expect.arrayContaining([a.did, b.did]))
            // Clear the debt, then let a new run begin after a reset: owed again.
            for (const s of [a, b]) await obj.putPlcLog(s.log([s.g], Date.now() + 10_000))
            expect(
                (await obj.owedPlcLogs(Date.now() + 1, 10)).filter((d) => d === a.did || d === b.did)
            ).toEqual([])
            await obj.advancePlcCursor(2, Date.now() - 1000)
            const restart = await obj.owedPlcLogs(Date.now() + 1, 10)
            expect(restart).toEqual(expect.arrayContaining([a.did, b.did]))
            // Within the run, more frames owe nothing new.
            for (const s of [a, b]) await obj.putPlcLog(s.log([s.g], Date.now() + 10_000))
            await obj.advancePlcCursor(3, Date.now())
            expect(
                (await obj.owedPlcLogs(Date.now() + 1, 10)).filter((d) => d === a.did || d === b.did)
            ).toEqual([])
        })
    })

    it("a stored log confirms the DID document it renders, as of its fetch", async () => {
        await inObj(stub(), async (obj, sql) => {
            const did = modern.did
            await join(obj, did)
            const entries = modern.audit.map((e) => ({
                cid: e.cid,
                operation: e.operation as Record<string, unknown>,
                createdAtMs: Date.parse(e.createdAt),
                nullified: e.nullified,
            }))
            const asOfMs = Date.now()
            await obj.putPlcLog({ did, entries, asOfMs })
            const row = sql
                .exec<{ document: string; confirmed_at: number; version: number }>(
                    "SELECT document, confirmed_at, version FROM did_documents WHERE did = ?",
                    did
                )
                .one()
            expect(row.document).toBe(canonicalDidDocumentJson(modern.document))
            expect(row.confirmed_at).toBe(asOfMs - FETCH_AS_OF_SKEW_MS)
            // The same state fetched again moves only the confirmation: no republish.
            await obj.putPlcLog({ did, entries, asOfMs: asOfMs + 5000 })
            const again = sql
                .exec<{ confirmed_at: number; version: number }>(
                    "SELECT confirmed_at, version FROM did_documents WHERE did = ?",
                    did
                )
                .one()
            expect(again.version).toBe(row.version)
            expect(again.confirmed_at).toBe(asOfMs + 5000 - FETCH_AS_OF_SKEW_MS)
        })
    })

    it("putPlcLog for a DID that left the kept set stores nothing", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.forgetLeft(s.did)
            await obj.completeDeletion(s.did, Date.now(), true)
            await obj.putPlcLog(s.log([s.g]))
            expect(logRows(sql).filter((r) => r.log !== null)).toEqual([])
            expect(sql.exec("SELECT 1 FROM did_documents WHERE did = ?", s.did).toArray()).toEqual([])
        })
    })

    it("a debt that arrives after a fetch began is still owed once the log is stored", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            const startedAt = Date.now() + 10_000
            await obj.owePlcLog(s.did, startedAt + 5000)
            await obj.putPlcLog(s.log([s.g], startedAt))
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([s.did])
            await obj.putPlcLog(s.log([s.g], startedAt + 6000))
            expect(await obj.owedPlcLogs(Date.now() + 1, 10)).toEqual([])
        })
    })

    it("a failed attempt backs a fetch off until the retry interval", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.markPlcLogAttempted(s.did, 1_000_000)
            expect(await obj.owedPlcLogs(1_000_000, 10)).toEqual([])
            expect(await obj.owedPlcLogs(1_000_001, 10)).toEqual([s.did])
        })
    })

    it("a DID leaving the kept set has its log and plclog: entry removed", async () => {
        await inObj(stub(), async (obj, sql) => {
            const s = synthetic()
            await join(obj, s.did)
            await obj.putPlcLog(s.log([s.g]))
            await obj.publishPlcLogs(10)
            expect(await kvLog(s.did)).not.toBeNull()
            await obj.forgetLeft(s.did)
            expect((await obj.publishPlcLogs(10)).published).toBe(1)
            expect(await testEnv.records.get(PLC_LOG_PREFIX + s.did)).toBeNull()
            expect(logRows(sql)).toEqual([])
            // A DID that never had a log published leaves no row to publish.
            const other = synthetic()
            await join(obj, other.did)
            await obj.forgetLeft(other.did)
            expect(logRows(sql)).toEqual([])
        })
    })

    it("kvPlcLogs reads back what was published; a malformed entry reads null", async () => {
        await inObj(stub(), async (obj) => {
            const s = synthetic()
            await join(obj, s.did)
            const log = s.log([s.g])
            await obj.putPlcLog(log)
            await obj.publishPlcLogs(10)
            expect(await kvLog(s.did)).toEqual(log)
            await testEnv.records.put(PLC_LOG_PREFIX + "did:plc:bad1", "{nope")
            await testEnv.records.put(PLC_LOG_PREFIX + "did:plc:bad2", JSON.stringify({ did: "did:plc:bad2", entries: [{}], asOfMs: 1 }))
            await testEnv.records.put(PLC_LOG_PREFIX + "did:plc:bad3", JSON.stringify({ ...log, did: "did:plc:other" }))
            for (const did of ["did:plc:bad1", "did:plc:bad2", "did:plc:bad3", "did:plc:absent"]) {
                expect(await kvLog(did)).toBeNull()
            }
        })
    })

    it("the alarm fetches an owed log, stores it and publishes it with its document", async () => {
        const s = stub()
        await inObj(s, async (obj) => {
            await join(obj, modern.did)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const original = globalThis.fetch
        const urls: string[] = []
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input)
            urls.push(url)
            if (url.includes("/log/audit")) return Response.json(modern.audit)
            return new Response(null, { status: 200 })
        }) as typeof fetch
        try {
            await runDurableObjectAlarm(s)
        } catch (err) {
            if (!/did not upgrade/.test(String(err))) throw err
        } finally {
            globalThis.fetch = original
        }
        expect(urls.some((u) => u.endsWith(`${encodeURIComponent(modern.did)}/log/audit`))).toBe(true)
        expect((await kvLog(modern.did))!.entries).toHaveLength(modern.audit.length)
        const doc = await testEnv.records.get(`doc:${modern.did}`, "json")
        expect((doc as { doc: unknown }).doc).toEqual(modern.document)
    })
})
