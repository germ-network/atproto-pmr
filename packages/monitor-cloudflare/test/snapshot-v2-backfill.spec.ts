/**
 * A one-shot backfill re-settles every held declaration and secondary from
 * its PDS, so every entry reaches the v2 layout.
 */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import {
    settleSecondaryDue,
    sweepSnapshotLayout,
    type FetchedRecord,
    type RecordRef,
    type SecondaryDeps,
    type VerifyOutcome,
} from "@germ-network/atproto-pmr-monitor"
import { describe, expect, it, vi } from "vitest"
import { normalizeMonitorHostname, type MonitorIngest } from "../src/ingest-object"
import { kvRecordSnapshots, kvSnapshotStore } from "../src/snapshot-store"
import { alarm, everyoneStub, inObj, meta, rowsOf, setEnv, sql } from "./listing-harness"

const PROFILE = "app.bsky.actor.profile"
const BLOCK = "app.bsky.graph.block"
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const REV = "3kaaaaaaaaaaa"
let n = 0
const uniqDid = () => `did:plc:v2b${(n += 1)}x${crypto.randomUUID().slice(0, 8)}`

const hold = (obj: MonitorIngest, did: string) =>
    obj.complete(did, REV, 1_000, {
        cid: "bafyreirecord",
        verifiedWith: KEY,
        commitCid: null,
        anchorKey: null,
        messagingKeyFingerprint: null,
        messagingKeyFirstSeenAtMs: null,
    })

function member(obj: MonitorIngest, did: string, opts: { registered?: boolean; member?: boolean } = {}): void {
    sql(
        obj,
        "INSERT INTO interest (did, registered, member, epoch) VALUES (?, ?, ?, 4) " +
            "ON CONFLICT(did) DO UPDATE SET registered = excluded.registered, member = excluded.member",
        did,
        opts.registered ? 1 : 0,
        opts.member === false ? 0 : 1
    )
}

function secondary(obj: MonitorIngest, did: string, collection = PROFILE, rkey = "self"): void {
    sql(
        obj,
        "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) VALUES (?, ?, ?, ?, 'bafyreisecondary', ?)",
        did,
        collection,
        rkey,
        REV,
        KEY
    )
}

const sweep = (obj: MonitorIngest, limit = 2) => sweepSnapshotLayout({ index: obj, limit })
const pendingDids = (obj: MonitorIngest) =>
    rowsOf<{ did: string }>(obj, "SELECT did FROM pending ORDER BY did").map((r) => r.did)
const recPending = (obj: MonitorIngest) =>
    rowsOf<{ did: string; collection: string; rkey: string; rev: string; epoch: number }>(
        obj,
        "SELECT did, collection, rkey, rev, epoch FROM rec_pending ORDER BY did, collection, rkey"
    )
async function sweepAll(obj: MonitorIngest): Promise<void> {
    for (let i = 0; i < 20; i++) if ((await sweep(obj)).done) return
}

describe("snapshot v2 backfill", () => {
    it("owes a fetch for every held declaration and every held secondary", async () => {
        const [a, b, c] = [uniqDid(), uniqDid(), uniqDid()]
        await inObj(everyoneStub("v2b"), async (obj) => {
            for (const did of [a, b, c]) {
                await hold(obj, did)
                member(obj, did)
            }
            secondary(obj, a)
            secondary(obj, c)
            await sweepAll(obj)
            expect(pendingDids(obj)).toEqual([a, b, c].sort())
            expect(rowsOf<{ quiet: number }>(obj, "SELECT quiet FROM pending").every((r) => r.quiet === 0)).toBe(true)
            expect(recPending(obj).map((r) => r.did)).toEqual([a, c].sort())
            for (const row of recPending(obj)) {
                const interest = rowsOf<{ epoch: number }>(obj, "SELECT epoch FROM interest WHERE did = ?", row.did)[0]!
                expect(row).toMatchObject({ collection: PROFILE, rkey: "self", rev: REV, epoch: interest.epoch })
            }
        })
    })

    it("runs once: a second wake after completion owes nothing", async () => {
        const did = uniqDid()
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, did)
            member(obj, did)
            await sweepAll(obj)
            expect(JSON.parse(meta(obj, "snapshot_v2_backfill")!)).toEqual({ done: true })
            sql(obj, "DELETE FROM pending")
            expect(await sweep(obj)).toEqual({ discovered: 0, done: true })
            expect(pendingDids(obj)).toEqual([])
        })
    })

    it("a re-settle at an unchanged rev rewrites the entry as v2 without a push", async () => {
        const did = uniqDid()
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, did)
            member(obj, did)
            await obj.recordSeenKey(did, KEY)
            // A snapshot left by the previous layout.
            const o = obj as unknown as {
                env: { records: KVNamespace }
                fetchRecord(did: string): Promise<FetchedRecord>
                verifyRecord(did: string, r: FetchedRecord): Promise<VerifyOutcome>
                deps(): { onChange?: unknown }
            }
            await o.env.records.put(`rec:${did}`, new Uint8Array([1]), {
                metadata: { rev: REV, observedAtMs: 1, source: "s", signingKey: KEY, verifiedWith: KEY, cid: "bafyreirecord", seenKey: null },
            })
            expect(await kvSnapshotStore(o.env as never).getRecord(did)).toBeNull()

            o.fetchRecord = async () => ({ car: new Uint8Array([9, 9]), source: "https://pds", signingKey: KEY })
            o.verifyRecord = async () => ({ kind: "verified", key: KEY, rev: REV, cid: "bafyreirecord" })
            const onChange = vi.fn()
            const realDeps = o.deps.bind(o)
            o.deps = () => ({ ...realDeps(), onChange }) as never

            await sweepAll(obj)
            const { settleDue } = await import("@germ-network/atproto-pmr-monitor")
            expect(await settleDue(o.deps() as never, 10)).toBeGreaterThan(0)
            expect(await kvSnapshotStore(o.env as never).getRecord(did)).toMatchObject({
                rev: REV,
                cid: "bafyreirecord",
                source: "https://pds",
            })
            expect(onChange).not.toHaveBeenCalled()
            expect(rowsOf(obj, "SELECT 1 FROM window_members WHERE did = ? AND window > 0", did)).toHaveLength(1)
        })
    })

    it("runs without MONITOR_HOSTNAME configured", async () => {
        const stub = everyoneStub("v2b")
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            setEnv(obj, { MONITOR_HOSTNAME: "" })
            await hold(obj, did)
            member(obj, did)
        })
        await alarm(stub)
        await inObj(stub, async (obj) => {
            expect(JSON.parse(meta(obj, "snapshot_v2_backfill")!)).toEqual({ done: true })
            expect(normalizeMonitorHostname(obj.env.MONITOR_HOSTNAME)).toBeNull()
            expect(pendingDids(obj)).toContain(did)
        })
    })

    it("a re-owed secondary and a registered owner's block proof are re-stored as v2 at their unchanged rev", async () => {
        const [did, owner] = [uniqDid(), uniqDid()]
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, did)
            member(obj, did)
            member(obj, owner, { registered: true })
            secondary(obj, did)
            secondary(obj, owner, BLOCK, "3kb")
            const o = obj as unknown as {
                secondaryDeps(): SecondaryDeps
                fetchRecordAt: (ref: RecordRef) => Promise<FetchedRecord>
                verifyRecordAt: (ref: RecordRef, record: FetchedRecord) => Promise<VerifyOutcome>
            }
            o.fetchRecordAt = async () => ({ car: new Uint8Array([6, 6]), source: "https://pds-new", signingKey: KEY })
            o.verifyRecordAt = async (ref) => ({ kind: "verified", key: KEY, rev: REV, cid: `bafyrei${ref.rkey}` })
            await sweepAll(obj)
            expect(recPending(obj)).toHaveLength(2)
            await settleSecondaryDue(o.secondaryDeps(), 32)
            await settleSecondaryDue(o.secondaryDeps(), 32, undefined, "own-blocks")
            expect(recPending(obj)).toEqual([])
            for (const [d, collection, rkey] of [[did, PROFILE, "self"], [owner, BLOCK, "3kb"]] as const) {
                expect(await kvRecordSnapshots(obj.env as never).get(d, collection, rkey)).toMatchObject({
                    rev: REV,
                    car: new Uint8Array([6, 6]),
                    verifiedWith: KEY,
                })
            }
        })
    })

    it("an owed secondary keeps its existing backoff", async () => {
        const did = uniqDid()
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, did)
            member(obj, did)
            secondary(obj, did)
            sql(
                obj,
                "INSERT INTO rec_pending (did, collection, rkey, rev, epoch, attempts, not_before, owed_at) VALUES (?, ?, 'self', '', 4, 3, 9999999999999, 1)",
                did,
                PROFILE
            )
            await sweepAll(obj)
            expect(
                rowsOf(obj, "SELECT rev, attempts, not_before, owed_at FROM rec_pending WHERE did = ?", did)
            ).toEqual([{ rev: "", attempts: 3, not_before: 9999999999999, owed_at: 1 }])
        })
    })

    it("an own-block proof of a registered owner is re-stored as v2", async () => {
        const [owner, other] = [uniqDid(), uniqDid()]
        await inObj(everyoneStub("v2b"), async (obj) => {
            member(obj, owner, { registered: true })
            member(obj, other)
            secondary(obj, owner, BLOCK, "3kb")
            secondary(obj, other, BLOCK, "3kb")
            await sweepAll(obj)
            expect(recPending(obj)).toMatchObject([{ did: owner, collection: BLOCK, rkey: "3kb", rev: REV }])
        })
    })

    it("a DID that is gone or not held is not owed", async () => {
        const [gone, unheld] = [uniqDid(), uniqDid()]
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, gone)
            member(obj, gone)
            await obj.markGoneReversible(gone, "record")
            // A declaration row with no held mark.
            secondary(obj, unheld, DECLARATION_COLLECTION_NSID, "self")
            member(obj, unheld)
            await sweepAll(obj)
            expect(pendingDids(obj)).toEqual([])
        })
    })

    it("a secondary of a DID outside interest is not owed", async () => {
        const did = uniqDid()
        await inObj(everyoneStub("v2b"), async (obj) => {
            await hold(obj, did)
            member(obj, did, { member: false })
            secondary(obj, did)
            await sweepAll(obj)
            expect(recPending(obj)).toEqual([])
        })
    })
})
