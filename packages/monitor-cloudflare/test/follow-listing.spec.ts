/**
 * Follow listings against the real object and D1: an owner's verified repo,
 * a non-owner's mutual hints, each read into staging, written at a fresh
 * generation in chunks across alarms within the listing reserve, and swept,
 * with the live ops logged meanwhile left to the flush that follows.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
    drainRecounts,
    flushEdgeOps,
    mirrorGraph,
    relistStale,
    type StatementBudget,
} from "@germ-network/atproto-pmr-monitor"
import { FetchTimeoutError, RecordNotFoundError, RepoCollectionError } from "@germ-network/atproto-pmr-core"
import { makeKey } from "../../core/test/fixtures/repo-car"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"
import {
    alarm,
    all,
    clearGraph,
    create,
    db,
    del,
    entriesOf,
    everyoneStub,
    follows,
    followsOf,
    inObj,
    listingRow,
    meta,
    putEdge,
    queueRow,
    queuedDids,
    ready,
    recountQueue,
    registeredStub,
    rkeyOf,
    rowsOf,
    setEnv,
    sql,
    stagedCount,
    step,
    drainAll,
    stubNet,
    priv,
    testEnv,
} from "./listing-harness"

beforeEach(clearGraph)

const O = "did:plc:owner"
const M = "did:plc:mutual"

const mirror = (obj: MonitorIngest, limit = 50) =>
    mirrorGraph(
        {
            index: obj,
            listings: obj,
            edges: d1FollowEdgeWriter(db, statementBudget(1000)),
            nowMs: () => Date.now(),
        },
        limit
    )
const graphOwners = async () =>
    (await all<{ did: string }>("SELECT did FROM graph_owners ORDER BY did")).map((r) => r.did)
const reasons = async (did: string) =>
    (await all<{ reason: string }>("SELECT reason FROM graph_changes WHERE did = ? ORDER BY seq", did)).map(
        (r) => r.reason
    )
const markPaged = (obj: MonitorIngest, did: string) =>
    sql(obj, "INSERT INTO listings (did, paged) VALUES (?, 1) ON CONFLICT(did) DO UPDATE SET paged = 1", did)
const flush = (obj: MonitorIngest) =>
    flushEdgeOps(
        {
            ops: obj,
            edges: d1FollowEdgeWriter(db, statementBudget(1000)),
            budget: statementBudget(1000),
            interest: obj,
        },
        1000
    )
const permanent = () => new RecordNotFoundError("gone", false, "RepoDeactivated")
const standing = (obj: MonitorIngest, did: string) => obj.standingOf(did)

describe("owner listing from getRepo", () => {
    it("a verified repo replaces the owner's edges at a new generation", async () => {
        const s = registeredStub("l")
        await putEdge(O, "old", "did:plc:old", 1)
        await inObj(s, async (obj) => {
            sql(obj, "INSERT INTO meta (k, v) VALUES ('listing_gen', '1')")
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(3) } })
            expect(await step(obj)).toEqual(["listed"])
            expect(meta(obj, "listing_gen")).toBe("2")
        })
        const rows = await followsOf(O)
        expect(rows.map((r) => r.rkey)).toEqual([rkeyOf(0), rkeyOf(1), rkeyOf(2)])
        expect(rows.every((r) => r.gen === 2)).toBe(true)
    })

    it("an owner's first completed listing mirrors it with served-add", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(2) } })
            await mirror(obj)
            expect(await graphOwners()).toEqual([])
            await step(obj)
            await mirror(obj)
            expect(await graphOwners()).toEqual([O])
            expect(await reasons(O)).toContain("served-add")
        })
    })

    it("verification failure keeps previous edges and backs off", async () => {
        const s = registeredStub("l")
        await putEdge(O, "old", "did:plc:old")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: new RepoCollectionError("signature-invalid", "bad") } })
            expect(await step(obj)).toEqual(["unverifiable"])
            const row = queueRow(obj, O)!
            expect(row.not_before).toBeGreaterThan(Date.now())
            expect(row.attempts).toBe(1)
            expect(await obj.dueListings(Date.now(), 10)).toEqual([])
        })
        expect((await followsOf(O)).map((r) => r.rkey)).toEqual(["old"])
    })

    it("the default config admits a listing after a full mirror batch", async () => {
        const s = registeredStub("l")
        await testEnv.pmrDirectory.put(O, "1")
        await inObj(s, async (obj) => {
            await obj.register(O)
            for (let i = 0; i < 60; i++) await obj.register(`did:plc:zextra${i}`)
            stubNet(obj, { repos: { [O]: entriesOf(2) } })
        })
        for (let i = 0; i < 60; i++) await testEnv.pmrDirectory.put(`did:plc:zextra${i}`, "1")
        await alarm(s)
        await inObj(s, async (obj) => {
            expect(listingRow(obj, O)?.listed_at).toBeTruthy()
        })
        expect((await followsOf(O)).length).toBe(2)
    })

    it("the graph mirror is capped to leave FOLLOW_LISTING_STATEMENT_RESERVE", async () => {
        const s = registeredStub("l")
        const limits = await inObj(s, async (obj) => {
            setEnv(obj, { GRAPH_MIRROR_BATCH: "200", GRAPH_STATEMENT_BUDGET: "1000" })
            const seen: number[] = []
            const original = obj.dueMirror.bind(obj)
            obj.dueMirror = (limit: number) => {
                seen.push(limit)
                return original(limit)
            }
            return { seen, obj }
        }).then(async ({ seen }) => {
            await alarm(s)
            return seen
        })
        expect(limits[0]).toBe(60)
    })

    it("a large verified repo drains across alarms and is served only after its sweep", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(6000) } })
            expect(await step(obj)).toEqual(["in-progress"])
            const partial = (await followsOf(O)).length
            expect(partial).toBeGreaterThan(0)
            expect(partial).toBeLessThan(6000)
            await mirror(obj)
            expect(await graphOwners()).toEqual([])
            const rest = await drainAll(obj)
            expect(rest.at(-1)).toEqual(["listed"])
            await mirror(obj)
            expect(await graphOwners()).toEqual([O])
        })
        expect(await followsOf(O)).toHaveLength(6000)
    })

    it("a follow deleted while its listing drains is not written back by a later chunk", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(6000) } })
            await step(obj)
            await del(obj, O, rkeyOf(5990))
            await flush(obj)
            await drainAll(obj)
        })
        const rows = await followsOf(O)
        expect(rows).toHaveLength(5999)
        expect(rows.some((r) => r.rkey === rkeyOf(5990))).toBe(false)
    })

    it("a flushed create removes its staged row, so a later chunk does not overwrite it", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(6000) } })
            await step(obj)
            await create(obj, O, rkeyOf(5990), "did:plc:live")
            await flush(obj)
            expect(
                rowsOf(obj, "SELECT 1 FROM listing_stage WHERE did = ? AND rkey = ?", O, rkeyOf(5990))
            ).toEqual([])
            await drainAll(obj)
        })
        const row = (await followsOf(O)).find((r) => r.rkey === rkeyOf(5990))
        expect(row?.subject).toBe("did:plc:live")
    })

    it("an oversized repo falls back to a paged listRecords listing", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            const net = stubNet(obj, {
                repos: { [O]: new RepoCollectionError("byte-cap-exceeded", "big") },
                lists: { [O]: entriesOf(3) },
            })
            expect(await step(obj)).toEqual(["switched-to-paged"])
            expect(listingRow(obj, O)?.paged).toBe(1)
            expect(stagedCount(obj)).toBe(0)
            expect(await step(obj)).toEqual(["listed"])
            expect(net.repoFetches).toHaveLength(1)
        })
        expect(await followsOf(O)).toHaveLength(3)
    })

    it("a walk past MAX_FOLLOWS records switches to the fallback", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            setEnv(obj, { MAX_FOLLOWS: "4" })
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(5) }, lists: { [O]: entriesOf(5) } })
            expect(await step(obj)).toEqual(["switched-to-paged"])
            expect(await step(obj)).toEqual(["listed"])
        })
        expect(await followsOf(O)).toHaveLength(5)
    })

    it("a hung getRepo times out", async () => {
        const s = registeredStub("l")
        const key = makeKey()
        const original = globalThis.fetch
        await inObj(s, async (obj) => {
            setEnv(obj, { FOLLOW_FETCH_TIMEOUT_MS: "40" })
            await obj.register(O)
            globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input instanceof Request ? input.url : input)
                if (url.startsWith("https://plc.directory/")) {
                    return Response.json({
                        id: O,
                        service: [
                            {
                                id: "#atproto_pds",
                                type: "AtprotoPersonalDataServer",
                                serviceEndpoint: "https://pds.example.test",
                            },
                        ],
                        verificationMethod: [
                            {
                                id: `${O}#atproto`,
                                type: "Multikey",
                                controller: O,
                                publicKeyMultibase: key.multikey,
                            },
                        ],
                    })
                }
                const body = new ReadableStream<Uint8Array>({
                    start(c) {
                        init?.signal?.addEventListener("abort", () =>
                            c.error(new DOMException("aborted", "AbortError"))
                        )
                    },
                })
                return new Response(body, { status: 200 })
            }) as typeof fetch
            try {
                expect(await step(obj)).toEqual(["failed"])
            } finally {
                globalThis.fetch = original
            }
            const row = queueRow(obj, O)!
            expect(row.timeouts).toBe(1)
            expect(row.not_before).toBeGreaterThan(Date.now())
        })
    })

    it("repeated getRepo timeouts switch the owner to the fallback", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: new FetchTimeoutError() }, lists: { [O]: entriesOf(2) } })
            const outcomes = []
            for (let i = 0; i < 3; i++) {
                ready(obj)
                outcomes.push(await step(obj))
            }
            expect(outcomes).toEqual([["failed"], ["failed"], ["switched-to-paged"]])
            expect(listingRow(obj, O)?.paged).toBe(1)
            expect(await step(obj)).toEqual(["listed"])
        })
    })

    it("at most FOLLOW_BACKFILL_REPOS listings run per alarm", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const dids = Array.from({ length: 6 }, (_, i) => `did:plc:o${i}`)
            for (const d of dids) await obj.register(d)
            const net = stubNet(obj, { repos: Object.fromEntries(dids.map((d) => [d, entriesOf(1)])) })
            const out = await step(obj)
            expect(net.repoFetches).toHaveLength(4)
            expect(out.filter((o) => o === "listed")).toHaveLength(4)
            await step(obj)
            expect(net.repoFetches).toHaveLength(6)
        })
    })

    it("a getRepo that fails before staging releases its in-progress slot", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: new Error("down") } })
            expect(await step(obj)).toEqual(["failed"])
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 0, "owner-paged": 0, mutual: 0 })
            expect(listingRow(obj, O)?.progress_kind).toBeNull()
        })
    })

    it("permanently failing listings do not block the in-progress caps", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const bad = Array.from({ length: 4 }, (_, i) => `did:plc:bad${i}`)
            for (const d of bad) await obj.register(d)
            await obj.register("did:plc:good")
            stubNet(obj, {
                repos: { ...Object.fromEntries(bad.map((d) => [d, permanent()])), "did:plc:good": entriesOf(2) },
            })
            await step(obj)
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 0, "owner-paged": 0, mutual: 0 })
            expect(await step(obj)).toContain("listed")
            expect(listingRow(obj, "did:plc:good")?.listed_at).toBeTruthy()
        })
    })

    it("a listing becomes unlistable after N permanent failures and returns on a new event", async () => {
        const s = registeredStub("l")
        await putEdge(O, "old", "did:plc:old")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: permanent() } })
            const outcomes = []
            for (let i = 0; i < 5; i++) {
                ready(obj)
                outcomes.push((await step(obj))[0])
            }
            expect(outcomes).toEqual(["failed", "failed", "failed", "failed", "unlistable"])
            expect(queueRow(obj, O)!.unlistable).toBe(1)
            expect(await obj.dueListings(Date.now() + 1e12, 10)).toEqual([])
            await obj.queueListing(O, Date.now(), "stale")
            await obj.queueListing(O, Date.now(), "gap")
            expect(queueRow(obj, O)!.unlistable).toBe(1)
            await obj.requeueListing(O, "5")
            const row = queueRow(obj, O)!
            expect([row.unlistable, row.attempts, row.not_before, row.permanent_failures]).toEqual([0, 0, 0, 0])
            expect((await obj.dueListings(Date.now(), 10)).map((l) => l.did)).toEqual([O])
        })
        expect((await followsOf(O)).map((r) => r.rkey)).toEqual(["old"])
    })

    it("after upgrade every owner and interest DID is queued once", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            expect(meta(obj, "listings_seeded")).toBe("1")
            await obj.register(O)
            await obj.setOwnerFollowers(M, 1, 1)
            sql(obj, "DELETE FROM listing_requeue")
            sql(obj, "DELETE FROM meta WHERE k = 'listings_seeded'")
            priv(obj).seedListings()
            expect(queuedDids(obj)).toEqual([M, O])
            sql(obj, "DELETE FROM listing_requeue")
            priv(obj).seedListings()
            expect(queuedDids(obj)).toEqual([])
        })
    })
})

describe("served flag", () => {
    it("a mutual-listed DID that registers is not served until its owner listing completes", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            stubNet(obj, { lists: { [M]: entriesOf(2) }, repos: { [M]: entriesOf(2) } })
            expect(await step(obj)).toEqual(["listed"])
            expect((await standing(obj, M)).owner).toBe(false)
            await obj.register(M)
            expect((await standing(obj, M)).owner).toBe(false)
            expect(await step(obj)).toEqual(["listed"])
            expect((await standing(obj, M)).owner).toBe(true)
        })
    })

    it("an owner that loses and regains ownership is not served until re-listed", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            stubNet(obj, { repos: { [O]: entriesOf(2) }, lists: { [O]: entriesOf(2) } })
            await step(obj)
            expect((await standing(obj, O)).owner).toBe(true)
            await obj.setRegistered(O, false, 2)
            expect((await standing(obj, O)).owner).toBe(false)
            await obj.setRegistered(O, true, 3)
            expect((await standing(obj, O)).owner).toBe(false)
            expect(queuedDids(obj)).toContain(O)
            await step(obj)
            expect((await standing(obj, O)).owner).toBe(true)
        })
    })

    it("a listing that completes after its DID stopped owning does not set owner_listed_at", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            stubNet(obj, {
                repos: {
                    [O]: async () => {
                        await obj.setRegistered(O, false, 2)
                        return entriesOf(2)
                    },
                },
                lists: { [O]: entriesOf(2) },
            })
            expect(await step(obj)).toEqual(["listed"])
            expect(listingRow(obj, O)?.owner_listed_at).toBeNull()
            expect(listingRow(obj, O)?.listed_at).toBeTruthy()
            expect(queuedDids(obj)).toEqual([O])
        })
    })

    it("ownership gained during a mutual listing's last step still queues the owner listing", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            const net = stubNet(obj, { lists: { [M]: entriesOf(2) }, repos: { [M]: entriesOf(2) } })
            const out = await step(obj, {
                wrapEdges: (edges) => ({
                    ...edges,
                    sweep: async (f, g) => {
                        await obj.register(M)
                        return edges.sweep(f, g)
                    },
                }),
            })
            expect(out).toEqual(["listed"])
            expect(queuedDids(obj)).toEqual([M])
            expect(await step(obj)).toEqual(["listed"])
            expect(net.repoFetches).toEqual([M])
            expect((await standing(obj, M)).owner).toBe(true)
        })
    })
})

describe("paged owner listing", () => {
    const pagedOwner = async (obj: MonitorIngest, count: number) => {
        await obj.register(O)
        markPaged(obj, O)
        return stubNet(obj, { lists: { [O]: entriesOf(count) }, pageSize: 2 })
    }

    it("a fallback listing resumes from its stored cursor in the next alarm", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const net = await pagedOwner(obj, 5)
            expect(await step(obj, { config: { pagesPerAlarm: 2 } })).toEqual(["in-progress"])
            expect(listingRow(obj, O)?.progress_cursor).toBe(rkeyOf(1))
            expect(await step(obj, { config: { pagesPerAlarm: 1 } })).toEqual(["in-progress"])
            expect(net.pages.map((p) => p.cursor)).toEqual([null, rkeyOf(1)])
            expect(net.resolves).toEqual([O])
            await drainAll(obj)
        })
        expect(await followsOf(O)).toHaveLength(5)
    })

    it("a fallback listing keeps every follow, not only registered subjects", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await pagedOwner(obj, 5)
            await step(obj)
        })
        expect((await followsOf(O)).map((r) => r.subject)).toEqual(entriesOf(5).map((r) => r.subject))
    })

    it("a fallback listing bumps gen at its start and sweeps older gens after its last chunk", async () => {
        const s = registeredStub("l")
        await putEdge(O, "old", "did:plc:old", 1)
        await inObj(s, async (obj) => {
            sql(obj, "INSERT INTO meta (k, v) VALUES ('listing_gen', '1')")
            await pagedOwner(obj, 5)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            expect(listingRow(obj, O)?.progress_gen).toBe(2)
            expect((await followsOf(O)).map((r) => r.rkey)).toEqual(["old"])
            await drainAll(obj)
        })
        const rows = await followsOf(O)
        expect(rows.map((r) => r.rkey)).toEqual(entriesOf(5).map((r) => r.rkey))
        expect(rows.every((r) => r.gen === 2)).toBe(true)
    })

    it("a fallback listing's completion emits served-add", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await pagedOwner(obj, 3)
            await step(obj)
            await mirror(obj)
        })
        expect(await reasons(O)).toContain("served-add")
        expect(await graphOwners()).toEqual([O])
    })

    it("a drained chunk's subjects are queued for re-count with its cursor", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            markPaged(obj, O)
            stubNet(obj, { lists: { [O]: entriesOf(6000) }, pageSize: 100 })
            expect(await step(obj)).toEqual(["in-progress"])
            const written = await followsOf(O)
            const cursor = listingRow(obj, O)?.progress_cursor
            expect(cursor).toBe(written.at(-1)!.rkey)
            expect(recountQueue(obj).sort()).toEqual(written.map((r) => r.subject).sort())
        })
    })

    it("a fallback owner stays on the paged listing when re-listed", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const net = await pagedOwner(obj, 2)
            await step(obj)
            await obj.queueListing(O, Date.now() + 1, "stale")
            await step(obj)
            expect(net.repoFetches).toEqual([])
            expect(net.resolves).toEqual([O, O])
        })
    })

    it("an op flushed mid-listing survives the listing's sweep", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            markPaged(obj, O)
            stubNet(obj, { lists: { [O]: entriesOf(6000) } })
            await step(obj)
            await create(obj, O, "live", "did:plc:live")
            await flush(obj)
            await drainAll(obj)
        })
        const rows = await followsOf(O)
        expect(rows).toHaveLength(6001)
        expect(rows.find((r) => r.rkey === "live")?.subject).toBe("did:plc:live")
    })

    it("a failed page leaves the cursor where it was and defers it", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const net = await pagedOwner(obj, 6)
            const list = (obj as unknown as { listFollows: (...a: unknown[]) => Promise<unknown> }).listFollows
            let calls = 0
            ;(obj as unknown as Record<string, unknown>).listFollows = (...a: unknown[]) => {
                calls += 1
                if (calls === 2) return Promise.reject(new Error("down"))
                return list(...a)
            }
            expect(await step(obj)).toEqual(["failed"])
            expect(listingRow(obj, O)?.progress_cursor).toBe(rkeyOf(1))
            expect(queueRow(obj, O)!.not_before).toBeGreaterThan(Date.now())
            expect(stagedCount(obj, O)).toBe(2)
            expect(net.pages).toHaveLength(1)
        })
    })

    it("a paged listing interrupted by a mutual listing restarts from the first page", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(O, 1, 1)
            const net = await pagedOwner(obj, 6)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            const first = listingRow(obj, O)?.progress_gen as number
            await obj.setRegistered(O, false, 5)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            expect(net.pages.map((p) => p.cursor)).toEqual([null, null])
            expect(listingRow(obj, O)?.progress_kind).toBe("mutual")
            expect(listingRow(obj, O)?.progress_gen as number).toBeGreaterThan(first)
        })
    })

    it("a paged listing whose DID left interest does not resume on rejoin", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            const net = await pagedOwner(obj, 6)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            await obj.setRegistered(O, false, 5)
            expect(listingRow(obj, O)?.progress_kind).toBeNull()
            expect(stagedCount(obj)).toBe(0)
            await obj.register(O)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            expect(net.pages.map((p) => p.cursor)).toEqual([null, null])
        })
    })

    it("a paged listing in progress is not re-queued over itself", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await pagedOwner(obj, 6)
            await step(obj, { config: { pagesPerAlarm: 2 } })
            const gen = listingRow(obj, O)?.progress_gen
            const queuedAt = queueRow(obj, O)!.queued_at
            for (const reason of ["join", "stale", "upgrade"] as const) {
                await obj.queueListing(O, Date.now() + 10, reason)
            }
            expect(listingRow(obj, O)?.progress_gen).toBe(gen)
            expect(stagedCount(obj, O)).toBe(2)
            expect(queueRow(obj, O)!.queued_at).toBe(queuedAt)
            await obj.queueListing(O, 1, "ownership")
            expect(listingRow(obj, O)?.progress_gen).toBe(gen)
            expect(queueRow(obj, O)!.queued_at).toBeGreaterThan(listingRow(obj, O)?.progress_began_at as number)
            await obj.queueListing(O, 1, "registration")
            expect(listingRow(obj, O)?.progress_kind).toBeNull()
            expect(stagedCount(obj, O)).toBe(0)
        })
    })
})

describe("mutual listing from listRecords", () => {
    it("keeps only follows of registered users", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            await obj.register("did:plc:r1")
            await obj.register("did:plc:r2")
            stubNet(obj, {
                lists: {
                    [M]: [
                        { rkey: "a", subject: "did:plc:r1" },
                        { rkey: "b", subject: "did:plc:stranger" },
                        { rkey: "c", subject: "did:plc:r2" },
                    ],
                },
            })
            expect(await step(obj, { config: {} })).toContain("listed")
        })
        expect((await followsOf(M)).map((r) => r.subject)).toEqual(["did:plc:r1", "did:plc:r2"])
    })

    it("pages until an empty page; absence of a cursor alone does not end", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            await obj.register("did:plc:r1")
            const net = stubNet(obj, {
                lists: {
                    [M]: [
                        { rkey: "a", subject: "did:plc:x" },
                        { rkey: "b", subject: "did:plc:x" },
                        { rkey: "c", subject: "did:plc:r1" },
                    ],
                },
                pageSize: 1,
            })
            await step(obj)
            expect(net.pages).toHaveLength(4)
        })
        expect((await followsOf(M)).map((r) => r.rkey)).toEqual(["c"])
    })

    it("re-list sweeps follows that no longer exist", async () => {
        const s = registeredStub("l")
        await putEdge(M, "gone", "did:plc:r1", 0)
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            await obj.register("did:plc:r1")
            stubNet(obj, { lists: { [M]: [{ rkey: "kept", subject: "did:plc:r1" }] } })
            await step(obj)
        })
        expect((await followsOf(M)).map((r) => r.rkey)).toEqual(["kept"])
    })

    it("a new registration re-queues its followees' mutual listings", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(M, 1, 1)
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, { repos: { [O]: [{ rkey: "a", subject: M }] } })
            await obj.queueListing(O, Date.now(), "join")
            await step(obj)
            expect(queuedDids(obj)).toEqual([M])
        })
    })
})

describe("listing queue and the alarm", () => {
    it("flush runs after listings in the alarm", async () => {
        const s = registeredStub("l")
        const seen: string[] = []
        await inObj(s, async (obj) => {
            for (const name of ["dueMirror", "dueQueuedCount", "dueListings", "edgeOps"] as const) {
                const original = obj[name].bind(obj) as (...a: unknown[]) => Promise<unknown>
                ;(obj as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
                    seen.push(name)
                    return original(...a)
                }
            }
        })
        await alarm(s)
        expect(seen.slice(0, 4)).toEqual(["dueMirror", "dueQueuedCount", "dueListings", "edgeOps"])
    })

    it("an owner listing's new followees join by the next re-count drain after their rows are written", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(2) } })
            await step(obj)
            expect(await obj.inInterest("did:plc:s0")).toBe(false)
            const budget: StatementBudget = statementBudget(1000)
            await drainRecounts(
                {
                    edges: d1FollowEdgeWriter(db, budget),
                    interest: obj,
                    nowMs: () => Date.now(),
                    queue: obj,
                    budget,
                },
                1000
            )
            expect(await obj.inInterest("did:plc:s0")).toBe(true)
            expect(await obj.inInterest("did:plc:s1")).toBe(true)
        })
    })

    it("an owner that stops owning but stays in interest queues a mutual listing", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            const net = stubNet(obj, { repos: { [O]: entriesOf(1) }, lists: { [O]: entriesOf(1) } })
            await step(obj)
            expect(queuedDids(obj)).toEqual([])
            await obj.setRegistered(O, false, 2)
            expect(queuedDids(obj)).toEqual([O])
            await step(obj)
            expect(net.repoFetches).toHaveLength(1)
            expect(net.pages.map((p) => p.did)).toContain(O)
        })
    })

    it("a non-owner join queues a mutual listing", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            expect(queuedDids(obj)).toEqual([M])
            const net = stubNet(obj, { lists: { [M]: [] } })
            await step(obj)
            expect(net.pages.map((p) => p.did)).toEqual([M])
        })
    })

    it("a join is not delayed by a full stale backlog", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            for (let i = 0; i < 210; i++) {
                const did = `did:plc:old${i}`
                sql(obj, "INSERT INTO interest (did, member) VALUES (?, 1)", did)
                sql(obj, "INSERT INTO listings (did, listed_at) VALUES (?, ?)", did, 1000 + i)
            }
            sql(obj, "DELETE FROM listing_requeue")
            const queued = await relistStale({ listings: obj, nowMs: () => 1e12 }, {
                relistAfterMs: 1,
                maxPerAlarm: 200,
            })
            expect(queued).toBe(200)
            expect(await obj.dueQueuedCount(Date.now())).toBe(200)
            await obj.register("did:plc:joiner")
            expect((await obj.dueListings(Date.now(), 5))[0]!.did).toBe("did:plc:joiner")
        })
    })

    it("a re-queue during a listing survives its completion", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, {
                repos: {
                    [O]: async () => {
                        await obj.queueListing(O, Date.now(), "ownership")
                        return entriesOf(1)
                    },
                },
            })
            expect(await step(obj)).toEqual(["listed"])
            expect(queuedDids(obj)).toEqual([O])
            stubNet(obj, { repos: { [O]: entriesOf(1) } })
            expect(await step(obj)).toEqual(["listed"])
            expect(queuedDids(obj)).toEqual([])
        })
    })

    it("only an owner's first listing re-queues its followees' mutual listings", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(M, 1, 1)
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, { repos: { [O]: [{ rkey: "a", subject: M }] } })
            await obj.queueListing(O, Date.now(), "stale")
            await step(obj)
            expect(queuedDids(obj)).toEqual([M])
            sql(obj, "DELETE FROM listing_requeue")
            await obj.queueListing(O, Date.now() + 1, "stale")
            await step(obj)
            expect(queuedDids(obj)).toEqual([])
        })
    })

    it("an owner's first completion does not re-list followees that own graphs", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.register("did:plc:peer")
            await obj.setOwnerFollowers(M, 1, 1)
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, {
                repos: {
                    [O]: [
                        { rkey: "a", subject: M },
                        { rkey: "b", subject: "did:plc:peer" },
                    ],
                },
            })
            await obj.queueListing(O, Date.now(), "join")
            await step(obj)
            expect(queuedDids(obj)).toEqual([M])
        })
    })

    it("a non-registered owner's first completion re-lists no followees", async () => {
        const s = everyoneStub("l")
        await inObj(s, async (obj) => {
            await obj.complete("did:plc:holder", "rev1", Date.now(), { cid: "bafy", verifiedWith: "k" })
            await obj.register("did:plc:r1")
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, { repos: { "did:plc:holder": [{ rkey: "a", subject: "did:plc:r1" }] } })
            await obj.queueListing("did:plc:holder", Date.now(), "join")
            await step(obj)
            expect(listingRow(obj, "did:plc:holder")?.owner_listed_at).toBeTruthy()
            expect(queuedDids(obj)).toEqual([])
        })
    })

    it("a listRecords listing that loses its PDS mid-fetch is cleared and released after N failures", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.setOwnerFollowers(M, 1, 1)
            await obj.register("did:plc:r1")
            const net = stubNet(obj, {
                lists: { [M]: [{ rkey: "a", subject: "did:plc:r1" }, { rkey: "b", subject: "did:plc:r1" }] },
                pageSize: 1,
            })
            const list = (obj as unknown as { listFollows: (...a: unknown[]) => Promise<unknown> }).listFollows
            let dead = false
            ;(obj as unknown as Record<string, unknown>).listFollows = (...a: unknown[]) => {
                if (net.pages.length >= 1) dead = true
                return dead ? Promise.reject(new Error("pds down")) : list(...a)
            }
            expect(await step(obj)).toContain("failed")
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 0, "owner-paged": 0, mutual: 1 })
            for (let i = 0; i < 2; i++) {
                ready(obj)
                await step(obj)
            }
            expect(queueRow(obj, M)!.unlistable).toBe(1)
            expect(stagedCount(obj)).toBe(0)
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 0, "owner-paged": 0, mutual: 0 })
        })
    })
})

describe("alarm cost", () => {
    it("an alarm's listing work stays under the subrequest limit", async () => {
        const s = registeredStub("l")
        const { net, statements } = await inObj(s, async (obj) => {
            const lists: Record<string, ReturnType<typeof entriesOf>> = {}
            for (let i = 0; i < 150; i++) {
                const did = `did:plc:m${i}`
                await obj.setOwnerFollowers(did, 1, 1)
                lists[did] = entriesOf(3)
            }
            const net = stubNet(obj, { lists, pageDelayMs: 3 })
            const budget = statementBudget(1000)
            await step(obj, { budget })
            return { net, statements: 1000 - budget.remaining }
        })
        expect(net.pages.length + net.resolves.length + net.repoFetches.length).toBeLessThan(500)
        expect(net.pages.length).toBeLessThanOrEqual(200)
        expect(statements).toBeLessThanOrEqual(400)
    })
})

describe("stale steps and kind changes", () => {
    const A = "did:plc:a1"
    const Z = "did:plc:z1"

    it("a listing whose kind no longer matches its DID's ownership is queued again", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(A)
            await obj.setOwnerFollowers(Z, 1, 1)
            const net = stubNet(obj, {
                repos: {
                    [A]: async () => {
                        await obj.register(Z)
                        return entriesOf(1)
                    },
                    [Z]: entriesOf(2),
                },
                lists: { [Z]: entriesOf(2) },
            })
            expect(await step(obj)).toEqual(["listed", "listed"])
            expect(queuedDids(obj)).toEqual([Z])
            expect(listingRow(obj, Z)?.owner_listed_at).toBeNull()
            expect(await step(obj)).toEqual(["listed"])
            expect(net.repoFetches).toEqual([A, Z])
            expect((await standing(obj, Z)).owner).toBe(true)
            expect(queuedDids(obj)).toEqual([])
        })
    })

    it("a failed resolve on a kind change backs off and does not hold its slot forever", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            stubNet(obj, { repos: { [O]: entriesOf(6000) }, lists: { [O]: entriesOf(3) } })
            expect(await step(obj)).toEqual(["in-progress"])
            const gen = listingRow(obj, O)?.progress_gen
            await obj.setRegistered(O, false, 2)
            const o = obj as unknown as Record<string, unknown>
            o.resolvePds = async () => {
                throw new Error("down")
            }
            expect(await step(obj)).toEqual(["failed"])
            expect(queueRow(obj, O)!.not_before).toBeGreaterThan(Date.now())
            expect(listingRow(obj, O)?.progress_gen).toBe(gen)
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 1, "owner-paged": 0, mutual: 0 })
            o.resolvePds = async () => {
                throw new RecordNotFoundError("gone", false, "RepoDeactivated")
            }
            for (let i = 0; i < 5; i++) {
                ready(obj)
                await step(obj)
            }
            expect(queueRow(obj, O)!.unlistable).toBe(1)
            expect(stagedCount(obj)).toBe(0)
            expect(await obj.inProgressCounts()).toEqual({ "owner-repo": 0, "owner-paged": 0, mutual: 0 })
        })
    })

    it("a step whose progress was restarted publishes nothing", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            let before: ReturnType<typeof queueRow>
            let began = 0
            stubNet(obj, {
                repos: {
                    [O]: async () => {
                        before = { ...queueRow(obj, O)! }
                        began = listingRow(obj, O)?.progress_began_at as number
                        await obj.requeueListing(O, "5")
                        return entriesOf(3)
                    },
                },
            })
            expect(await step(obj)).toEqual(["superseded"])
            expect(stagedCount(obj)).toBe(0)
            expect(await follows()).toEqual([])
            const row = queueRow(obj, O)!
            expect(row.queued_at).toBeGreaterThan(began)
            expect([row.attempts, row.not_before]).toEqual([before!.attempts, before!.not_before])
            expect(listingRow(obj, O)?.progress_kind).toBeNull()
        })
    })

    it("a sync during the sweep does not stamp the listing as listed", async () => {
        const s = registeredStub("l")
        await inObj(s, async (obj) => {
            await obj.register(O)
            stubNet(obj, { repos: { [O]: entriesOf(3) } })
            const out = await step(obj, {
                wrapEdges: (edges) => ({
                    ...edges,
                    sweep: async (f, g) => {
                        await obj.requeueListing(O, "5")
                        return edges.sweep(f, g)
                    },
                }),
            })
            expect(out).toEqual(["superseded"])
            expect(listingRow(obj, O)?.listed_at).toBeNull()
            expect(listingRow(obj, O)?.owner_listed_at).toBeNull()
            expect(queuedDids(obj)).toEqual([O])
        })
    })
})

describe("listing documents", () => {
    it.todo("a listing's fetched document is recorded")
})
