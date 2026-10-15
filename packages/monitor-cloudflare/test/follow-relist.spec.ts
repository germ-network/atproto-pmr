/**
 * Re-listing when the live stream may have missed follows: an outage longer
 * than Jetstream replays, and a listing simply grown old.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { relistStale } from "@germ-network/atproto-pmr-monitor"
import type { MonitorIngest } from "../src/ingest-object"
import {
    clearGraph,
    inObj,
    listingRow,
    meta,
    queueRow,
    queuedDids,
    registeredStub,
    sql,
    stagedCount,
} from "./listing-harness"

beforeEach(clearGraph)

const HOUR = 3_600_000
const A = "did:plc:a"
const B = "did:plc:b"

/** Jetstream stand-in: `up` hands out a socket pair, otherwise the upgrade fails. */
let up = false
const original = globalThis.fetch
afterEach(() => {
    globalThis.fetch = original
})
function stubJetstream() {
    globalThis.fetch = (async () => {
        if (!up) return new Response(null, { status: 200 })
        const [client, server] = Object.values(new WebSocketPair())
        server!.accept()
        return new Response(null, { status: 101, webSocket: client })
    }) as typeof fetch
}

const setConnectedAgo = (obj: MonitorIngest, ms: number) =>
    sql(
        obj,
        "INSERT INTO meta (k, v) VALUES ('last_connected_at', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1",
        String(Date.now() - ms)
    )
const connect = (obj: MonitorIngest) => obj.connectFollow().catch(() => undefined)

async function twoListed(obj: MonitorIngest) {
    await obj.register(A)
    await obj.register(B)
    sql(obj, "DELETE FROM listing_requeue")
}

describe("gap and staleness re-list", () => {
    it("outage past lookback re-lists all listings", async () => {
        stubJetstream()
        up = false
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await twoListed(obj)
            setConnectedAgo(obj, 40 * HOUR)
            await connect(obj)
            expect(queuedDids(obj)).toEqual([A, B])
        })
    })

    it("a quiet socket with old event times does not re-list", async () => {
        stubJetstream()
        up = true
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await twoListed(obj)
            sql(obj, "INSERT INTO meta (k, v) VALUES ('follow_cursor', ?)", String((Date.now() - 100 * HOUR) * 1000))
            setConnectedAgo(obj, HOUR)
            await connect(obj)
            expect(queuedDids(obj)).toEqual([])
            expect(meta(obj, "gap_requeued_for")).toBeUndefined()
        })
    })

    it("an outage ended by start() rather than the alarm still re-lists", async () => {
        stubJetstream()
        up = true
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await twoListed(obj)
            setConnectedAgo(obj, 40 * HOUR)
            await obj.start().catch(() => undefined)
            expect(queuedDids(obj)).toEqual([A, B])
            expect(Date.now() - Number(meta(obj, "last_connected_at"))).toBeLessThan(HOUR)
        })
    })

    it("stale listing is re-queued", async () => {
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await twoListed(obj)
            const now = Date.now()
            sql(obj, "INSERT INTO listings (did, listed_at) VALUES (?, ?)", A, now - 8 * 24 * HOUR)
            sql(obj, "INSERT INTO listings (did, listed_at) VALUES (?, ?)", B, now - HOUR)
            const queued = await relistStale(
                { listings: obj, nowMs: () => now },
                { relistAfterMs: 7 * 24 * HOUR, maxPerAlarm: 200 }
            )
            expect(queued).toBe(1)
            expect(queuedDids(obj)).toEqual([A])
            expect(queueRow(obj, A)!.low_priority).toBe(1)
        })
    })

    it("the stale re-queue skips DIDs already queued and advances past them", async () => {
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            for (let i = 0; i < 5; i++) {
                sql(obj, "INSERT INTO interest (did, member) VALUES (?, 1)", `did:plc:s${i}`)
                sql(obj, "INSERT INTO listings (did, listed_at) VALUES (?, ?)", `did:plc:s${i}`, 100 + i)
            }
            sql(obj, "DELETE FROM listing_requeue")
            await obj.queueListing("did:plc:s0", 1, "join")
            await obj.queueListing("did:plc:s1", 1, "join")
            expect(await obj.queueStaleListings(1000, 2, 5000)).toBe(2)
            expect(queuedDids(obj)).toEqual(["did:plc:s0", "did:plc:s1", "did:plc:s2", "did:plc:s3"])
        })
    })

    it("unlistable DIDs are skipped by the stale, upgrade and gap re-queues", async () => {
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await obj.register(A)
            sql(obj, "INSERT INTO listings (did, listed_at) VALUES (?, 1)", A)
            sql(obj, "UPDATE listing_requeue SET unlistable = 1, attempts = 3 WHERE did = ?", A)
            expect(await obj.queueStaleListings(1000, 10, 5000)).toBe(0)
            await obj.queueAllListings(5000, "upgrade")
            await obj.queueAllListings(5000, "gap")
            await obj.queueListing(A, 5000, "stale")
            const row = queueRow(obj, A)!
            expect([row.unlistable, row.attempts]).toEqual([1, 3])
            expect(await obj.dueListings(Date.now(), 10)).toEqual([])
        })
    })

    it("repeated failed reconnects re-queue the gap once", async () => {
        stubJetstream()
        up = false
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await twoListed(obj)
            setConnectedAgo(obj, 40 * HOUR)
            const stored = meta(obj, "last_connected_at")
            await connect(obj)
            expect(queuedDids(obj)).toEqual([A, B])
            expect(meta(obj, "gap_requeued_for")).toBe(stored)
            sql(obj, "DELETE FROM listing_requeue")
            await connect(obj)
            await connect(obj)
            expect(queuedDids(obj)).toEqual([])
            up = true
            await connect(obj)
            expect(queuedDids(obj)).toEqual([])
            expect(meta(obj, "last_connected_at")).not.toBe(stored)
        })
    })

    it("the gap re-queue restarts listings in progress but keeps attempts and not_before", async () => {
        stubJetstream()
        up = false
        const s = registeredStub("relist")
        await inObj(s, async (obj) => {
            await obj.register(A)
            const began = Date.now() - 1000
            sql(
                obj,
                "INSERT INTO listings (did, progress_kind, progress_gen, progress_phase, progress_began_at) " +
                    "VALUES (?, 'mutual', 3, 'fetch', ?)",
                A,
                began
            )
            sql(obj, "INSERT INTO listing_stage (did, collection, rkey, subject) VALUES (?, 'follow', 'x', 'did:plc:y')", A)
            const future = Date.now() + HOUR
            sql(obj, "UPDATE listing_requeue SET attempts = 2, not_before = ?, queued_at = ? WHERE did = ?", future, began - 5, A)
            setConnectedAgo(obj, 40 * HOUR)
            await connect(obj)
            expect(listingRow(obj, A)?.progress_kind).toBeNull()
            expect(stagedCount(obj, A)).toBe(0)
            const row = queueRow(obj, A)!
            expect([row.attempts, row.not_before]).toEqual([2, future])
            expect(row.queued_at).toBeGreaterThan(began)
        })
    })
})
