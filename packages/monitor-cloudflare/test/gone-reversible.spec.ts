/**
 * RecordNotFound no longer marks a DID permanently gone: only a gone repo
 * (RepoNotFound, a PLC tombstone) does. DIDs marked gone before that rule
 * are asked once more; only a revival is announced.
 */
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    refreshDue,
    settleDue,
    type IngestDeps,
    type RefreshDeps,
    type SecondaryDeps,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"
import { buildRepoCar } from "../../core/test/fixtures/repo-car"
import { kvSnapshotStore } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const VERIFIED = { cid: "bafyreistub", verifiedWith: KEY }
const HOUR = 3_600_000

let n = 0
const freshStub = () => testEnv.ingest.get(testEnv.ingest.idFromName(`gone-reversible-${(n += 1)}`))
const freshRegistered = () =>
    testEnv.ingestRegistered.get(testEnv.ingestRegistered.idFromName(`gone-reversible-r-${(n += 1)}`))

function inObj<R>(
    stub: DurableObjectStub<MonitorIngest>,
    fn: (obj: MonitorIngest, sql: SqlStorage) => R | Promise<R>
): Promise<R> {
    return runInDurableObject(stub, (instance, state) =>
        fn(instance as MonitorIngest, state.storage.sql)
    )
}

const privately = <T>(obj: MonitorIngest) => obj as unknown as T
const depsOf = (obj: MonitorIngest) => privately<{ deps(): IngestDeps }>(obj).deps()
const secondaryDepsOf = (obj: MonitorIngest) =>
    privately<{ secondaryDeps(): SecondaryDeps }>(obj).secondaryDeps()

const rows = (sql: SqlStorage, query: string, ...args: unknown[]) =>
    sql.exec(query, ...args).toArray()
const deletedRow = (sql: SqlStorage, did = DID) => rows(sql, "SELECT did FROM deleted WHERE did = ?", did)
const holder = (sql: SqlStorage, did = DID) =>
    rows(sql, "SELECT state, cause FROM holder_state WHERE did = ?", did)[0]

/** `did` as the pre-upgrade monitor left it after a permanent answer. */
async function permanentlyGone(obj: MonitorIngest, did = DID) {
    await obj.complete(did, "3m1", 1_000, VERIFIED)
    await obj.completeDeletion(did, 2_000, true, false, "repo")
}

describe("a reversible answer lifts a permanent mark", () => {
    it("a reversible gone answer for a DID with a deleted row drops the row and leaves it gone-reversible", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await permanentlyGone(obj)
            expect(deletedRow(sql)).toHaveLength(1)
            await obj.completeDeletion(DID, 3_000, false, false, "repo")
            expect(deletedRow(sql)).toEqual([])
            expect(holder(sql)).toMatchObject({ state: "gone-reversible", cause: "repo" })
            expect(await obj.isDeleted(DID)).toBe(false)
            expect(rows(sql, "SELECT 1 FROM did_documents WHERE did = ?", DID)).toEqual([])

            await permanentlyGone(obj, "did:plc:bob")
            await obj.markGoneReversible("did:plc:bob", "record")
            expect(deletedRow(sql, "did:plc:bob")).toEqual([])
            expect(holder(sql, "did:plc:bob")).toMatchObject({ state: "gone-reversible", cause: "record" })
        })
    })

    it("a gone-reversible DID is a refresh candidate again under everyone", async () => {
        await inObj(freshStub(), async (obj) => {
            await permanentlyGone(obj)
            const now = Date.now()
            expect(await obj.dueRefresh(now + 1_000, 10, now + 1_000)).toEqual([])
            await obj.completeDeletion(DID, 3_000, false, false, "repo")
            expect(await obj.dueRefresh(now + 1_000, 10, now + 1_000)).toEqual([DID])
        })
    })

    it("a permanent answer still writes the deleted row and gone-permanent", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await obj.complete(DID, "3m1", 1_000, VERIFIED)
            await obj.completeDeletion(DID, 2_000, true, false, "repo")
            expect(deletedRow(sql)).toHaveLength(1)
            expect(holder(sql)).toMatchObject({ state: "gone-permanent" })
        })
    })

    const document = { id: DID, service: [] }
    const docRow = (sql: SqlStorage, did = DID) =>
        rows(sql, "SELECT confirmed_at, version FROM did_documents WHERE did = ?", did)[0] as
            | { confirmed_at: number; version: number }
            | undefined

    it("a DID downgraded from deleted to gone-reversible by a pending settle, and left unwatched, has its stored DID document marked stale", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await permanentlyGone(obj)
            await obj.recordDidDocument(DID, document, 5_000)
            expect(docRow(sql)?.confirmed_at).toBeGreaterThan(0)
            await obj.owe(DID, "3m1")
            const o = privately<Record<string, unknown>>(obj)
            o.fetchRecord = async () => {
                throw new RecordNotFoundError("RecordNotFound", false, "RecordNotFound")
            }
            await settleDue(depsOf(obj))
            expect(deletedRow(sql)).toEqual([])
            expect(docRow(sql)?.confirmed_at).toBe(0)
        })
    })

    it("a downgraded DID that stays watched keeps its stored DID document confirmed", async () => {
        await inObj(freshRegistered(), async (obj, sql) => {
            await obj.setRegistered(DID, true, 1)
            await permanentlyGone(obj)
            await obj.recordDidDocument(DID, document, 5_000)
            const before = docRow(sql)
            await obj.completeDeletion(DID, 3_000, false, false, "repo")
            expect(deletedRow(sql)).toEqual([])
            expect(docRow(sql)).toEqual(before)
        })
    })

    it("under registered, a downgraded did:plc interest member is owed its plc log again", async () => {
        await inObj(freshRegistered(), async (obj, sql) => {
            await obj.setRegistered(DID, true, 1)
            await permanentlyGone(obj)
            sql.exec("DELETE FROM plc_logs WHERE did = ?", DID)
            await obj.completeDeletion(DID, 3_000, false, false, "repo")
            const row = rows(sql, "SELECT owed_at FROM plc_logs WHERE did = ?", DID)[0] as
                | { owed_at: number | null }
                | undefined
            expect(row?.owed_at).toBeGreaterThan(0)
        })
    })

    const owedAt = (sql: SqlStorage) =>
        (
            rows(sql, "SELECT owed_at FROM plc_logs WHERE did = ?", DID)[0] as
                | { owed_at: number | null }
                | undefined
        )?.owed_at ?? null

    for (const path of ["complete", "completeQuietly"] as const) {
        const revive = (obj: MonitorIngest) => obj[path](DID, "3m2", 3_000, VERIFIED)
        for (const [policy, stub] of [
            ["registered", freshRegistered],
            ["everyone", freshStub],
        ] as const) {
            it(`under ${policy}, a registered did:plc revived by ${path} after a permanent answer is owed its plc log again`, async () => {
                await inObj(stub(), async (obj, sql) => {
                    await obj.setRegistered(DID, true, 1)
                    await permanentlyGone(obj)
                    expect(owedAt(sql)).toBeNull()
                    await revive(obj)
                    expect(deletedRow(sql)).toEqual([])
                    expect(owedAt(sql)).toBeGreaterThan(0)
                })
            })
        }

        it(`under everyone, an unregistered did:plc revived by ${path} still rejoins, and the rejoin keeps the one plc log debt`, async () => {
            await inObj(freshStub(), async (obj, sql) => {
                await permanentlyGone(obj)
                expect(owedAt(sql)).toBeNull()
                await revive(obj)
                const owed = owedAt(sql)
                expect(owed).toBeGreaterThan(0)
                const [join] = (await obj.dueTransitions(10)).filter((t) => t.did === DID)
                expect(join?.change).toBe("join")
                await obj.oweJoin(DID, [], join!.epoch)
                expect(owedAt(sql)).toBe(owed)
            })
        })
    }

    it("a held DID answered RecordNotFound, then republished, is held again through dueRefresh and refresh with no firehose commit", async () => {
        await inObj(freshStub(), async (obj, sql) => {
            await obj.complete(DID, "3m1", 1_000, VERIFIED)
            await obj.owe(DID, "3m2")
            const o = privately<Record<string, unknown>>(obj)
            o.fetchRecord = async () => {
                throw new RecordNotFoundError("RecordNotFound", false, "RecordNotFound")
            }
            await settleDue(depsOf(obj))
            expect(holder(sql)).toMatchObject({ state: "gone-reversible" })
            expect(deletedRow(sql)).toEqual([])

            o.fetchHeadRev = async () => ({ rev: "3m3", signingKey: KEY })
            const car = buildRepoCar({
                did: DID,
                records: { [`${testEnv.MONITOR_COLLECTION}/self`]: { $type: testEnv.MONITOR_COLLECTION, n: 2 } },
            }).car
            o.fetchRecord = async () => ({ car, source: "https://pds", signingKey: KEY })
            o.verifyRecord = async () => ({ kind: "verified", key: KEY, rev: "3m3", cid: "bafyreinew" })
            const now = Date.now()
            expect(await obj.dueRefresh(now + HOUR, 10, now + HOUR)).toEqual([DID])
            const refresh: RefreshDeps = {
                ingest: depsOf(obj),
                refreshIndex: obj,
                refreshSnapshots: kvSnapshotStore(testEnv),
                fetchHeadRev: (did) => privately<{ fetchHeadRev(d: string): Promise<{ rev: string; signingKey: string | null }> }>(obj).fetchHeadRev(did),
                collection: testEnv.MONITOR_COLLECTION,
                rkey: "self",
                secondary: { deps: secondaryDepsOf(obj), records: [] },
            }
            const result = await refreshDue(refresh, {
                nowMs: now + HOUR,
                staleAfterMs: HOUR,
                nonHolderStaleAfterMs: HOUR,
                limit: 10,
            })
            expect(result.outcomes.changed).toBe(1)
            expect(holder(sql)).toMatchObject({ state: "held" })
            expect(await obj.revOf(DID)).toBe("3m3")
        })
    })
})

describe("the one-time re-owe of DIDs marked deleted before the upgrade", () => {
    const BOB = "did:plc:bob"
    const PENDING = "SELECT rev, attempts, not_before, quiet FROM pending WHERE did = ?"

    /** Leaves `dids` marked deleted with no pending row and no seed flag, then reopens. */
    async function upgraded(stub: DurableObjectStub<MonitorIngest>, dids: string[], extra?: (sql: SqlStorage) => void) {
        for (const did of dids) await kvSnapshotStore(testEnv).deleteRecord(did)
        await inObj(stub, async (obj, sql) => {
            for (const did of dids) await permanentlyGone(obj, did)
            sql.exec("DELETE FROM pending")
            sql.exec("DELETE FROM window_members")
            sql.exec("DELETE FROM meta WHERE k = 'deleted_reowed'")
            extra?.(sql)
        })
        await evictDurableObject(stub)
    }

    /** Settles whatever is owed against a PDS answering `answer`, with the hooks spied. */
    async function settleWith(
        obj: MonitorIngest,
        answer: "gone-record" | "gone-repo" | "live" | "excluded"
    ) {
        const o = privately<Record<string, unknown>>(obj)
        const car = buildRepoCar({
            did: DID,
            records: { [`${testEnv.MONITOR_COLLECTION}/self`]: { $type: testEnv.MONITOR_COLLECTION, n: 1 } },
        }).car
        o.fetchRecord = async () => {
            if (answer === "gone-record") {
                throw new RecordNotFoundError("RecordNotFound", false, "RecordNotFound")
            }
            if (answer === "gone-repo") {
                throw new RecordNotFoundError("RepoNotFound", true, "RepoNotFound")
            }
            return { car, source: "https://pds", signingKey: KEY }
        }
        o.verifyRecord = async () =>
            answer === "excluded"
                ? { kind: "verified-absent", key: KEY, rev: "3m2" }
                : { kind: "verified", key: KEY, rev: "3m1", cid: "bafyreinew" }
        const onChange = vi.fn(async () => {})
        const onDelete = vi.fn(async () => {})
        await settleDue({ ...depsOf(obj), onChange, onDelete })
        return { onChange, onDelete }
    }
    const windowed = (sql: SqlStorage) => rows(sql, "SELECT did FROM window_members")

    it("every deleted DID keeps its earlier selection turn, and the seed never runs twice across evictions", async () => {
        const stub = freshStub()
        const t0 = Date.now()
        await upgraded(stub, [DID, BOB])
        await inObj(stub, async (obj, sql) => {
            await obj.owe("did:plc:live", "3m9")
            for (const did of [DID, BOB]) {
                expect(rows(sql, PENDING, did)[0]).toMatchObject({ rev: "", attempts: 0, quiet: 0 })
                expect(rows(sql, PENDING, did)[0]?.not_before).toBeGreaterThanOrEqual(t0)
            }
            const due = await obj.duePending(Date.now() + 1_000, 10)
            expect([DID, BOB]).toContain(due[0]?.did)
            expect(due.at(-1)?.did).toBe("did:plc:live")
            expect(due.map((d) => d.did).sort()).toEqual(["did:plc:live", BOB, DID].sort())
            await obj.clearPending(DID)
        })
        await evictDurableObject(stub)
        await inObj(stub, async (_obj, sql) => {
            expect(rows(sql, PENDING, DID)).toEqual([])
            expect(rows(sql, PENDING, BOB)).toHaveLength(1)
        })
    })

    it("a deleted DID with a live record at its indexed rev is held again, announced with a window entry and onChange, and its deleted row is gone", async () => {
        const stub = freshStub()
        await upgraded(stub, [DID])
        await inObj(stub, async (obj, sql) => {
            const { onChange } = await settleWith(obj, "live")
            expect(deletedRow(sql)).toEqual([])
            expect(holder(sql)).toMatchObject({ state: "held" })
            expect(windowed(sql)).toEqual([{ did: DID }])
            expect(onChange).toHaveBeenCalledWith(DID, "3m1")
        })
    })

    it("a deleted DID answering RecordNotFound becomes gone-reversible with no window entry and no onDelete", async () => {
        const stub = freshStub()
        await upgraded(stub, [DID])
        await inObj(stub, async (obj, sql) => {
            const { onDelete } = await settleWith(obj, "gone-record")
            expect(deletedRow(sql)).toEqual([])
            expect(holder(sql)).toMatchObject({ state: "gone-reversible" })
            expect(windowed(sql)).toEqual([])
            expect(onDelete).not.toHaveBeenCalled()
        })
    })

    it("a deleted DID answering with a signed exclusion proof becomes gone-reversible, cause record, and verifiedAnchorOf answers absent", async () => {
        const stub = freshStub()
        await upgraded(stub, [DID])
        await inObj(stub, async (obj, sql) => {
            await settleWith(obj, "excluded")
            expect(deletedRow(sql)).toEqual([])
            expect(holder(sql)).toMatchObject({ state: "gone-reversible", cause: "record" })
            expect(await obj.verifiedAnchorOf(DID)).toEqual({ state: "absent" })
        })
    })

    it("a deleted DID answering RepoNotFound stays deleted and gone-permanent", async () => {
        const stub = freshStub()
        await upgraded(stub, [DID])
        await inObj(stub, async (obj, sql) => {
            const { onDelete } = await settleWith(obj, "gone-repo")
            expect(deletedRow(sql)).toHaveLength(1)
            expect(holder(sql)).toMatchObject({ state: "gone-permanent" })
            expect(windowed(sql)).toEqual([])
            expect(onDelete).not.toHaveBeenCalled()
        })
    })

    it("an existing pending row for a deleted DID keeps its rev and backoff but is made non-quiet", async () => {
        const stub = freshStub()
        await upgraded(stub, [DID], (sql) =>
            sql.exec(
                "INSERT INTO pending (did, rev, attempts, not_before, quiet, owed_at) VALUES (?, '3m5', 2, 9000000000000, 1, 5)",
                DID
            )
        )
        await inObj(stub, async (_obj, sql) => {
            expect(rows(sql, PENDING, DID)[0]).toEqual({
                rev: "3m5",
                attempts: 2,
                not_before: 9_000_000_000_000,
                quiet: 0,
            })
        })
    })
})
