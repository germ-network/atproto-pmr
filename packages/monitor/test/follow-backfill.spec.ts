import { describe, expect, it } from "vitest"
import {
    BodyTooLargeError,
    FetchTimeoutError,
    RecordNotFoundError,
    RepoCollectionError,
    type VerifiedCollection,
} from "@germ-network/atproto-pmr-core"
import {
    drainChunkEdges,
    followGapExceeded,
    followRecordsOf,
    relistStale,
    runListings,
    worstCaseDrainStatements,
    type FetchedRepo,
    type FollowBackfillConfig,
    type FollowBackfillDeps,
    type FollowPage,
    type FollowRecord,
    type ListingIndex,
    type ListingKind,
    type ListingOutcome,
    type QueuedListing,
} from "../src/follow-backfill"
import type { FollowEdge } from "@germ-network/atproto-pmr-core"
import type { EdgeWriteResult, StatementBudget } from "../src/storage"

const NOW = 1_000_000
const SIGNING_KEY = "zQ3shKey"

const config: FollowBackfillConfig = {
    repos: 4,
    listRecordsInProgress: 100,
    statementReserve: 400,
    maxFollows: 20_000,
    maxRepoBytes: 1_000_000,
    maxMstNodes: 1_000,
    pagesPerAlarm: 200,
    timeoutsBeforePaged: 3,
    retryBaseMs: 1_000,
    retryMaxMs: 86_400_000,
    permanentFailuresBeforeUnlistable: 5,
}

interface Row extends QueuedListing {
    queuedAt: number
}

/** A ListingIndex that guards on gen as the real one does, handing out copies. */
function fakeListings(clock: { now: number }) {
    const rows = new Map<string, Row>()
    const staging = new Map<string, FollowRecord[]>()
    let gen = 0
    const calls = {
        begin: [] as {
            did: string
            kind: ListingKind
            pds: string | null
            notBeforeMs: number
        }[],
        resume: [] as { did: string; notBeforeMs: number }[],
        defer: [] as {
            did: string
            gen: number | null
            notBeforeMs: number
            cause: { timedOut: boolean; permanent: boolean }
        }[],
        stage: [] as { did: string; rows: FollowRecord[]; cursor: string | null; done: boolean }[],
        switched: [] as string[],
        dropped: [] as string[],
        completed: [] as { did: string; subjects: readonly string[] }[],
        recount: [] as string[],
        staleQueued: [] as { before: number; limit: number }[],
    }
    const copy = (r: Row): QueuedListing => ({
        did: r.did,
        attempts: r.attempts,
        notBeforeMs: r.notBeforeMs,
        timeouts: r.timeouts,
        permanentFailures: r.permanentFailures,
        paged: r.paged,
        inProgress: r.inProgress === null ? null : { ...r.inProgress },
    })
    const live = (did: string, g: number): Row | null => {
        const r = rows.get(did)
        return r?.inProgress?.gen === g ? r : null
    }
    let dueQueued = 0
    const index: ListingIndex = {
        async dueListings(nowMs, limit) {
            const due = [...rows.values()].filter((r) => r.notBeforeMs <= nowMs)
            const progress = due
                .filter((r) => r.inProgress !== null)
                .sort((a, b) => a.inProgress!.beganAtMs - b.inProgress!.beganAtMs)
            const queued = due.filter((r) => r.inProgress === null)
            return [...progress, ...queued].slice(0, limit).map(copy)
        },
        async inProgressCounts() {
            const counts: Record<ListingKind, number> = {
                "owner-repo": 0,
                "owner-paged": 0,
                mutual: 0,
            }
            for (const r of rows.values()) {
                if (r.inProgress === null) continue
                const due = r.notBeforeMs <= clock.now
                if (due || (staging.get(r.did)?.length ?? 0) > 0) counts[r.inProgress.kind] += 1
            }
            return counts
        },
        async dueQueuedCount() {
            return dueQueued
        },
        async beginListing(did, kind, nowMs, pds, notBeforeMs) {
            calls.begin.push({ did, kind, pds, notBeforeMs })
            const r = rows.get(did)!
            gen += 1
            r.attempts += 1
            r.notBeforeMs = notBeforeMs
            staging.set(did, [])
            r.inProgress = { kind, gen, phase: "fetch", cursor: null, pds, beganAtMs: nowMs, pages: 0 }
            return { gen, beganAtMs: nowMs }
        },
        async resumeListing(did, g, notBeforeMs) {
            const r = live(did, g)
            if (r === null) return false
            calls.resume.push({ did, notBeforeMs })
            r.attempts += 1
            r.notBeforeMs = notBeforeMs
            return true
        },
        async stageRows(did, g, newRows, cursor, done) {
            const r = live(did, g)
            if (r === null) return false
            calls.stage.push({ did, rows: [...newRows], cursor, done })
            staging.get(did)!.push(...newRows)
            r.attempts = 0
            r.timeouts = 0
            r.notBeforeMs = 0
            if (r.inProgress!.kind !== "owner-repo") r.inProgress!.pages += 1
            r.inProgress!.cursor = cursor
            if (done) r.inProgress!.phase = "drain"
            if (done) r.inProgress!.cursor = null
            return true
        },
        async stagedRows(did, after, limit) {
            return (staging.get(did) ?? [])
                .filter((s) => after === null || s.rkey > after)
                .sort((a, b) => (a.rkey < b.rkey ? -1 : 1))
                .slice(0, limit)
        },
        async saveDrainProgress(did, g, cursor, subjects) {
            const r = live(did, g)
            if (r === null) return false
            r.inProgress!.cursor = cursor
            r.attempts = 0
            r.notBeforeMs = 0
            calls.recount.push(...subjects)
            return true
        },
        async switchToPaged(did, g, nowMs) {
            const r = live(did, g)
            if (r === null) return false
            calls.switched.push(did)
            r.paged = true
            r.inProgress = null
            r.notBeforeMs = nowMs
            staging.set(did, [])
            return true
        },
        async completeListing(did, g, done) {
            const r = live(did, g)
            if (r === null) return false
            calls.completed.push({ did, subjects: done.subjects })
            rows.delete(did)
            staging.delete(did)
            return true
        },
        async deferListing(did, g, notBeforeMs, cause, unlistableAfter) {
            calls.defer.push({ did, gen: g, notBeforeMs, cause })
            const r = rows.get(did)
            if (r === undefined) return "superseded"
            if (g === null ? r.inProgress !== null : r.inProgress?.gen !== g) return "superseded"
            if (cause.timedOut) r.timeouts += 1
            if (cause.permanent) r.permanentFailures += 1
            if (r.permanentFailures >= unlistableAfter) {
                r.inProgress = null
                staging.set(did, [])
                r.notBeforeMs = Number.MAX_SAFE_INTEGER
                return "unlistable"
            }
            r.notBeforeMs = notBeforeMs
            if ((staging.get(did)?.length ?? 0) === 0) r.inProgress = null
            return "deferred"
        },
        async dropListing(did) {
            calls.dropped.push(did)
            rows.delete(did)
            staging.delete(did)
        },
        async lastListedAt() {
            return null
        },
        async queueListing() {},
        async queueAllListings() {
            return 0
        },
        async queueStaleListings(before, limit) {
            calls.staleQueued.push({ before, limit })
            return limit
        },
    }
    return {
        index,
        calls,
        rows,
        staging,
        setDueQueued: (n: number) => (dueQueued = n),
        queue(did: string, overrides: Partial<Row> = {}) {
            const row: Row = {
                did,
                attempts: 0,
                notBeforeMs: 0,
                timeouts: 0,
                permanentFailures: 0,
                paged: false,
                inProgress: null,
                queuedAt: 0,
                ...overrides,
            }
            rows.set(did, row)
            if (overrides.inProgress) staging.set(did, [])
            return row
        },
        stage(did: string, n: number, prefix = "k") {
            staging.set(
                did,
                Array.from({ length: n }, (_, i) => ({
                    rkey: `${prefix}${String(i).padStart(6, "0")}`,
                    subject: `did:plc:s${i}`,
                }))
            )
        },
    }
}

function budgetOf(total: number): StatementBudget & { spent(): number } {
    let remaining = total
    return {
        get remaining() {
            return remaining
        },
        take(count) {
            if (count > remaining) return false
            remaining -= count
            return true
        },
        spent: () => total - remaining,
    }
}

const verified = (subjects: (string | null)[]): VerifiedCollection => ({
    rev: "r",
    records: subjects.map((s, i) => ({
        rkey: `r${String(i).padStart(4, "0")}`,
        cid: "bafy",
        record: s === null ? { other: 1 } : { subject: s },
    })),
})

const fetched = (signingKey: string | null = SIGNING_KEY): FetchedRepo => ({
    car: (async function* () {})(),
    signingKey,
    source: "https://pds.example",
    didDocument: { document: { id: "did:plc:x" } as never, fetchedAtMs: NOW },
})

interface Harness {
    deps: FollowBackfillDeps
    listings: ReturnType<typeof fakeListings>
    budget: ReturnType<typeof budgetOf>
    clock: { now: number }
    puts: { follower: string; rkeys: string[]; gen: number }[]
    sweeps: { follower: string; gen: number }[]
    owners: Set<string>
    registered: Set<string>
    left: Set<string>
    verifyKeys: string[]
    resolved: string[]
    inflight: { max: number }
    overrides: Partial<FollowBackfillDeps>
}

function harness(overrides: Partial<FollowBackfillDeps> = {}, budgetTotal = 1000): Harness {
    const clock = { now: NOW }
    const listings = fakeListings(clock)
    const budget = budgetOf(budgetTotal)
    const puts: Harness["puts"] = []
    const sweeps: Harness["sweeps"] = []
    const owners = new Set<string>()
    const registered = new Set<string>()
    const left = new Set<string>()
    const verifyKeys: string[] = []
    const resolved: string[] = []
    const inflight = { max: 0 }
    let active = 0
    const result = (subjects: string[]): EdgeWriteResult => ({ subjects })
    const deps: FollowBackfillDeps = {
        listings: listings.index,
        interest: {
            isGraphOwner: async (d) => owners.has(d),
            inInterest: async (d) => !left.has(d),
            isRegistered: async (d) => registered.has(d),
        },
        edges: {
            async putEdges(edges: readonly FollowEdge[], gen: number) {
                const cost = 4 * Math.ceil(edges.length / 25) + 1
                if (!budget.take(cost)) throw new Error("D1 statement budget exceeded")
                puts.push({ follower: edges[0]!.follower, rkeys: edges.map((e) => e.rkey), gen })
                return result([...new Set(edges.map((e) => e.subject))])
            },
            async sweep(follower: string, gen: number) {
                if (!budget.take(3)) throw new Error("D1 statement budget exceeded")
                sweeps.push({ follower, gen })
                return result(["did:plc:swept"])
            },
        } as unknown as FollowBackfillDeps["edges"],
        budget,
        async fetchRepo() {
            active += 1
            inflight.max = Math.max(inflight.max, active)
            await Promise.resolve()
            active -= 1
            return fetched()
        },
        async verifyRepo(_car, expected) {
            verifyKeys.push(expected.signingKey)
            return verified(["did:plc:a", "did:plc:b"])
        },
        async resolvePds(did) {
            resolved.push(did)
            return "https://pds.example"
        },
        async listFollows(): Promise<FollowPage> {
            return { records: [], lastRkey: null }
        },
        nowMs: () => clock.now,
        ...overrides,
    }
    return {
        deps,
        listings,
        budget,
        clock,
        puts,
        sweeps,
        owners,
        registered,
        left,
        verifyKeys,
        resolved,
        inflight,
        overrides,
    }
}

const run = (h: Harness, c: Partial<FollowBackfillConfig> = {}) =>
    runListings(h.deps, { ...config, ...c })

/** Pages of one follow each, ending with an empty page after `count` pages. */
const pagesOf = (count: number) => {
    const calls: (string | null)[] = []
    return {
        calls,
        async listFollows(_pds: string, _did: string, cursor: string | null): Promise<FollowPage> {
            calls.push(cursor)
            const n = cursor === null ? 0 : Number(cursor.slice(1)) + 1
            if (n >= count) return { records: [], lastRkey: null }
            return {
                records: [{ rkey: `p${String(n).padStart(4, "0")}`, subject: `did:plc:f${n}` }],
                lastRkey: `p${String(n).padStart(4, "0")}`,
            }
        },
    }
}

describe("follow listings", () => {
    it("one drain chunk's worst case plus the sweep fits the default reserve", () => {
        expect(worstCaseDrainStatements(1, true)).toBe(8)
        expect(worstCaseDrainStatements(25, false)).toBe(5)
        expect(worstCaseDrainStatements(26, false)).toBe(9)
        expect(worstCaseDrainStatements(0, true)).toBe(3)
        expect(worstCaseDrainStatements(2_475, true)).toBe(400)
        expect(worstCaseDrainStatements(2_476, true)).toBeGreaterThan(400)
    })

    it("drainChunkEdges is the largest chunk whose worst case fits", () => {
        expect(drainChunkEdges(400)).toBe(2_475)
        for (let statements = 0; statements <= 450; statements++) {
            const edges = drainChunkEdges(statements)
            if (edges > 0) {
                expect(worstCaseDrainStatements(edges, true)).toBeLessThanOrEqual(statements)
            }
            expect(worstCaseDrainStatements(edges + 1, true)).toBeGreaterThan(statements)
        }
    })

    it("a listing for a DID no longer in interest is dropped", async () => {
        const h = harness()
        h.listings.queue("did:plc:gone")
        h.left.add("did:plc:gone")
        expect(await run(h)).toEqual(["not-in-interest"])
        expect(h.listings.calls.dropped).toEqual(["did:plc:gone"])
        expect(h.listings.calls.begin).toEqual([])
    })

    it("listings run one at a time", async () => {
        const h = harness()
        for (const d of ["a", "b", "c"]) {
            h.owners.add(`did:plc:${d}`)
            h.listings.queue(`did:plc:${d}`)
        }
        expect(await run(h)).toEqual(["listed", "listed", "listed"])
        expect(h.inflight.max).toBe(1)
    })

    it("listRecords listings are not limited by FOLLOW_BACKFILL_REPOS", async () => {
        const h = harness({ listFollows: pagesOf(1).listFollows })
        for (let i = 0; i < 6; i++) h.listings.queue(`did:plc:m${i}`)
        const outcomes = await run(h, { repos: 1 })
        expect(outcomes).toEqual(Array(6).fill("listed"))
        expect(h.listings.calls.begin).toHaveLength(6)
    })

    it("only deferred listings holding staged rows count against the cap", async () => {
        const progress = {
            kind: "owner-repo" as const,
            gen: 1,
            phase: "fetch" as const,
            cursor: null,
            pds: null,
            beganAtMs: 1,
            pages: 0,
        }
        const empty = harness()
        const full = harness()
        for (const h of [empty, full]) {
            h.owners.add("did:plc:new")
            for (let i = 0; i < 2; i++) {
                h.owners.add(`did:plc:d${i}`)
                h.listings.queue(`did:plc:d${i}`, {
                    notBeforeMs: NOW + 10_000,
                    inProgress: { ...progress, gen: i + 1 },
                })
            }
            h.listings.queue("did:plc:new")
        }
        full.listings.stage("did:plc:d0", 1)
        full.listings.stage("did:plc:d1", 1)

        await run(empty, { repos: 2 })
        expect(empty.listings.calls.begin.map((b) => b.did)).toEqual(["did:plc:new"])
        await run(full, { repos: 2 })
        expect(full.listings.calls.begin).toEqual([])
    })

    it("the fair share never falls below one chunk and the sweep", async () => {
        const h = harness()
        for (let i = 0; i < 100; i++) {
            const did = `did:plc:m${String(i).padStart(3, "0")}`
            h.listings.queue(did, {
                inProgress: {
                    kind: "mutual",
                    gen: i + 1,
                    phase: "drain",
                    cursor: null,
                    pds: "p",
                    beganAtMs: i,
                    pages: 0,
                },
            })
            h.listings.stage(did, 100)
        }
        await run(h)
        const first = h.puts.slice(0, 50)
        expect(new Set(first.map((p) => p.follower)).size).toBe(50)
        expect(first.every((p) => p.rkeys.length === 25)).toBe(true)
        expect(h.budget.spent()).toBeLessThanOrEqual(400)
    })

    it("a repo-level terminal answer, an unverifiable repo and an unresolvable PDS count as permanent failures", async () => {
        const causes = async (override: Partial<FollowBackfillDeps>, owner = true) => {
            const h = harness(override)
            if (owner) h.owners.add("did:plc:x")
            h.listings.queue("did:plc:x")
            const outcomes = await run(h)
            return { outcomes, calls: h.listings.calls }
        }
        const gone = await causes({
            fetchRepo: async () => {
                throw new RecordNotFoundError("RepoDeactivated", false, "RepoDeactivated")
            },
        })
        expect(gone.calls.defer[0]!.cause).toEqual({ timedOut: false, permanent: true })

        const missingRecord = await causes({
            fetchRepo: async () => {
                throw new RecordNotFoundError("RecordNotFound", true, "RecordNotFound")
            },
        })
        expect(missingRecord.calls.defer[0]!.cause.permanent).toBe(false)

        const bad = await causes({
            verifyRepo: async () => {
                throw new RepoCollectionError("signature-invalid", "bad")
            },
        })
        expect(bad.outcomes).toEqual(["unverifiable"])
        expect(bad.calls.defer[0]!.cause.permanent).toBe(true)

        const unresolved = await causes(
            {
                resolvePds: async () => {
                    throw new RecordNotFoundError("tombstone", true)
                },
            },
            false
        )
        expect(unresolved.calls.defer[0]).toMatchObject({
            gen: null,
            cause: { timedOut: false, permanent: true },
        })

        const unreachable = await causes(
            {
                resolvePds: async () => {
                    throw new Error("network down")
                },
            },
            false
        )
        expect(unreachable.calls.defer[0]).toMatchObject({
            gen: null,
            cause: { timedOut: false, permanent: false },
        })

        const transient = await causes({
            fetchRepo: async () => {
                throw new Error("boom")
            },
        })
        expect(transient.outcomes).toEqual(["failed"])
        expect(transient.calls.defer[0]!.cause).toEqual({ timedOut: false, permanent: false })
    })

    it("a repeated permanent failure ends in unlistable", async () => {
        const h = harness({
            verifyRepo: async () => {
                throw new RepoCollectionError("signature-invalid", "bad")
            },
        })
        h.owners.add("did:plc:x")
        h.listings.queue("did:plc:x", { permanentFailures: 4 })
        expect(await run(h)).toEqual(["unlistable"])
    })

    it("retry backoff stops growing at retryMaxMs", async () => {
        const delays: number[] = []
        for (const attempts of [0, 1, 2, 3, 40]) {
            const h = harness({
                fetchRepo: async () => {
                    throw new Error("boom")
                },
            })
            h.owners.add("did:plc:x")
            h.listings.queue("did:plc:x", { attempts })
            await run(h)
            delays.push(h.listings.calls.defer[0]!.notBeforeMs - NOW)
        }
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, config.retryMaxMs])
    })

    it("at most one paged owner listing is in progress", async () => {
        const pages = pagesOf(3)
        const h = harness({ listFollows: pages.listFollows })
        for (const d of ["a", "b"]) {
            h.owners.add(`did:plc:${d}`)
            h.listings.queue(`did:plc:${d}`, { paged: true })
        }
        await run(h)
        expect(h.listings.calls.begin.map((b) => b.did)).toEqual(["did:plc:a"])
    })

    it("a large drain does not stop a new owner listing from beginning", async () => {
        const h = harness()
        h.listings.queue("did:plc:big", {
            inProgress: {
                kind: "mutual",
                gen: 1,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
            pages: 0,
            },
        })
        h.listings.stage("did:plc:big", 20_000)
        h.owners.add("did:plc:new")
        h.listings.queue("did:plc:new")
        const outcomes = await run(h)
        expect(outcomes).toEqual(["in-progress", "listed"])
        expect(h.puts.some((p) => p.follower === "did:plc:new")).toBe(true)
        expect(h.budget.spent()).toBeLessThanOrEqual(400)
    })

    it("a failed PDS resolve defers without beginning", async () => {
        const h = harness({
            resolvePds: async () => {
                throw new Error("nope")
            },
        })
        h.listings.queue("did:plc:m")
        expect(await run(h)).toEqual(["failed"])
        expect(h.listings.calls.begin).toEqual([])
        expect(h.listings.calls.defer[0]!.gen).toBeNull()
    })

    it("a superseded step neither defers nor switches the restarted listing", async () => {
        const restart = async (h: Harness) => {
            await h.listings.index.beginListing("did:plc:x", "owner-repo", NOW, null, 0)
        }
        const failing = harness()
        failing.owners.add("did:plc:x")
        failing.listings.queue("did:plc:x")
        failing.deps.fetchRepo = async () => {
            await restart(failing)
            throw new Error("boom")
        }
        expect(await run(failing)).toEqual(["superseded"])
        expect(failing.listings.rows.get("did:plc:x")!.notBeforeMs).toBe(0)

        const capped = harness()
        capped.owners.add("did:plc:x")
        capped.listings.queue("did:plc:x")
        capped.deps.verifyRepo = async () => {
            await restart(capped)
            throw new RepoCollectionError("byte-cap-exceeded", "big")
        }
        expect(await run(capped)).toEqual(["superseded"])
        expect(capped.listings.rows.get("did:plc:x")!.paged).toBe(false)
    })

    it("the repo is verified under the key of the document fetched with it; a document with no #atproto key is unverifiable", async () => {
        const h = harness({ fetchRepo: async () => fetched("zQ3shOther") })
        h.owners.add("did:plc:x")
        h.listings.queue("did:plc:x")
        await run(h)
        expect(h.verifyKeys).toEqual(["zQ3shOther"])

        const none = harness({ fetchRepo: async () => fetched(null) })
        none.owners.add("did:plc:x")
        none.listings.queue("did:plc:x")
        expect(await run(none)).toEqual(["unverifiable"])
        expect(none.verifyKeys).toEqual([])
        expect(none.listings.calls.defer[0]!.cause.permanent).toBe(true)
    })

    it("byte, node and record caps switch to the paged listing, not failed", async () => {
        const errors = [
            new BodyTooLargeError(),
            new RepoCollectionError("byte-cap-exceeded", "x"),
            new RepoCollectionError("node-cap-exceeded", "x"),
            new RepoCollectionError("record-cap-exceeded", "x"),
        ]
        for (const error of errors) {
            const h = harness({
                verifyRepo: async () => {
                    throw error
                },
            })
            h.owners.add("did:plc:x")
            h.listings.queue("did:plc:x")
            expect(await run(h)).toEqual(["switched-to-paged"])
            expect(h.listings.calls.switched).toEqual(["did:plc:x"])
            expect(h.listings.calls.defer).toEqual([])
        }
    })

    it("repeated getRepo timeouts switch the owner to pages on the last one", async () => {
        const timeout = async (): Promise<FetchedRepo> => {
            throw new FetchTimeoutError()
        }
        const first = harness({ fetchRepo: timeout })
        first.owners.add("did:plc:x")
        first.listings.queue("did:plc:x", { timeouts: 1 })
        expect(await run(first)).toEqual(["failed"])
        expect(first.listings.calls.defer[0]!.cause).toEqual({ timedOut: true, permanent: false })

        const last = harness({ fetchRepo: timeout })
        last.owners.add("did:plc:x")
        last.listings.queue("did:plc:x", { timeouts: 2 })
        expect(await run(last)).toEqual(["switched-to-paged"])
    })

    it("pages across all listings stop at pagesPerAlarm", async () => {
        const pages = pagesOf(100)
        const h = harness({ listFollows: pages.listFollows })
        for (let i = 0; i < 3; i++) h.listings.queue(`did:plc:m${i}`)
        const outcomes = await run(h, { pagesPerAlarm: 5 })
        expect(pages.calls).toHaveLength(4)
        expect(h.resolved).toHaveLength(1)
        expect(outcomes).toContain("over-budget")
    })

    it("the PDS is resolved once per listing", async () => {
        const pages = pagesOf(3)
        const h = harness({ listFollows: pages.listFollows })
        h.registered.add("did:plc:f0").add("did:plc:f1").add("did:plc:f2")
        h.listings.queue("did:plc:m")
        const outcomes: ListingOutcome[] = []
        for (let i = 0; i < 9; i++) {
            outcomes.push(...(await run(h, { pagesPerAlarm: 1 })))
            h.clock.now += 100_000
        }
        expect(outcomes).toContain("listed")
        expect(h.resolved).toEqual(["did:plc:m"])
        expect(h.listings.calls.begin).toHaveLength(1)
        expect(h.puts.flatMap((p) => p.rkeys)).toEqual(["p0000", "p0001", "p0002"])
    })

    it("a page of only malformed records does not end the fetch", async () => {
        const answers: FollowPage[] = [
            { records: [], lastRkey: "a" },
            { records: [{ rkey: "b", subject: "did:plc:f" }], lastRkey: "b" },
            { records: [], lastRkey: null },
        ]
        const seen: (string | null)[] = []
        const h = harness({
            listFollows: async (_p, _d, cursor) => {
                seen.push(cursor)
                return answers[seen.length - 1]!
            },
        })
        h.registered.add("did:plc:f")
        h.listings.queue("did:plc:m")
        await run(h)
        expect(seen).toEqual([null, "a", "b"])
        expect(h.listings.calls.stage.map((s) => [s.cursor, s.done])).toEqual([
            ["a", false],
            ["b", false],
            ["b", true],
        ])
    })

    it("the mutual fetch stops at maxFollows and keeps what it has", async () => {
        let n = 0
        const h = harness({
            listFollows: async () => {
                n += 1
                return {
                    records: [{ rkey: `k${String(n).padStart(3, "0")}`, subject: `did:plc:f${n}` }],
                    lastRkey: `k${String(n).padStart(3, "0")}`,
                }
            },
        })
        h.deps.interest.isRegistered = async (d) => d === "did:plc:f1"
        h.listings.queue("did:plc:m")
        await run(h, { maxFollows: 300, pagesPerAlarm: 3 })
        expect(n).toBe(2)
        await run(h, { maxFollows: 300, pagesPerAlarm: 3 })
        expect(n).toBe(3)
        expect(h.listings.calls.stage.map((s) => s.done)).toEqual([false, false, true])
        expect(h.puts.flatMap((p) => p.rkeys)).toEqual(["k001"])
        expect(h.listings.calls.completed).toHaveLength(1)
    })

    it("a cursor that does not advance ends the fetch", async () => {
        for (const owner of [false, true]) {
            const seen: (string | null)[] = []
            const h = harness({
                listFollows: async (_p, _d, cursor) => {
                    seen.push(cursor)
                    return { records: [{ rkey: "a", subject: "did:plc:f" }], lastRkey: "a" }
                },
            })
            h.deps.interest.isRegistered = async () => true
            if (owner) h.owners.add("did:plc:m")
            h.listings.queue("did:plc:m", { paged: owner })
            expect(await run(h)).toEqual(["listed"])
            expect(seen).toEqual([null, "a"])
            expect(h.listings.calls.stage.map((s) => s.done)).toEqual([false, true])
        }
    })

    it("failed pages and the PDS resolve count against pagesPerAlarm", async () => {
        const calls: string[] = []
        const h = harness({
            listFollows: async (_p, did) => {
                calls.push(did)
                throw new Error("down")
            },
        })
        for (let i = 0; i < 4; i++) h.listings.queue(`did:plc:m${i}`)
        const outcomes = await run(h, { pagesPerAlarm: 3 })
        expect(calls).toEqual(["did:plc:m0"])
        expect(h.resolved).toEqual(["did:plc:m0", "did:plc:m1"])
        expect(outcomes.slice(2)).toEqual(["over-budget", "over-budget"])
    })

    it("a begin or resume with no later commit leaves the DID not due", async () => {
        const h = harness({ fetchRepo: () => new Promise(() => {}) })
        h.owners.add("did:plc:x")
        h.listings.queue("did:plc:x", { attempts: 2 })
        void run(h)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(h.listings.calls.begin[0]!.notBeforeMs).toBe(NOW + 4_000)
        expect(await h.listings.index.dueListings(NOW, 10)).toEqual([])

        const d = harness()
        d.listings.queue("did:plc:m", {
            attempts: 1,
            inProgress: {
                kind: "mutual",
                gen: 5,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
                pages: 0,
            },
        })
        d.listings.stage("did:plc:m", 3)
        d.deps.edges.putEdges = () => new Promise(() => {})
        void run(d)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(d.listings.calls.resume).toEqual([{ did: "did:plc:m", notBeforeMs: NOW + 2_000 }])
        expect(await d.listings.index.dueListings(NOW, 10)).toEqual([])
    })

    it("a drain that cannot fit a chunk does not resume the listing", async () => {
        const h = harness()
        const row = h.listings.queue("did:plc:m", {
            attempts: 1,
            inProgress: {
                kind: "mutual",
                gen: 5,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
                pages: 0,
            },
        })
        h.listings.stage("did:plc:m", 3)
        expect(await run(h, { statementReserve: 4 })).toEqual(["over-budget"])
        expect(h.listings.calls.resume).toEqual([])
        expect(row.attempts).toBe(1)
    })

    it("a failed PDS resolve backs off from attempts plus one", async () => {
        const h = harness({
            resolvePds: async () => {
                throw new Error("down")
            },
        })
        h.listings.queue("did:plc:m", { attempts: 3 })
        await run(h)
        expect(h.listings.calls.defer[0]!.notBeforeMs).toBe(NOW + 8_000)
    })

    it("a failed page is a timed-out fetch step unless the answer is permanent", async () => {
        const cause = async (error: Error) => {
            const h = harness({
                listFollows: async () => {
                    throw error
                },
            })
            h.listings.queue("did:plc:m")
            await run(h)
            return h.listings.calls.defer[0]!.cause
        }
        expect(await cause(new Error("down"))).toEqual({ timedOut: true, permanent: false })
        expect(
            await cause(new RecordNotFoundError("RepoDeactivated", false, "RepoDeactivated"))
        ).toEqual({ timedOut: false, permanent: true })
    })

    it("a resume that lost its progress during the fetch phase does not fetch", async () => {
        let fetched = 0
        const h = harness({
            listFollows: async () => {
                fetched += 1
                return { records: [], lastRkey: null }
            },
        })
        h.listings.queue("did:plc:m", {
            inProgress: {
                kind: "mutual",
                gen: 5,
                phase: "fetch",
                cursor: "a",
                pds: "p",
                beganAtMs: 1,
                pages: 1,
            },
        })
        h.listings.index.resumeListing = async () => false
        expect(await run(h)).toEqual(["superseded"])
        expect(fetched).toBe(0)
    })

    it("keeps only follows of registered users", async () => {
        const h = harness({
            listFollows: async (_p, _d, cursor) =>
                cursor === null
                    ? {
                          records: [
                              { rkey: "a", subject: "did:plc:yes" },
                              { rkey: "b", subject: "did:plc:no" },
                          ],
                          lastRkey: "b",
                      }
                    : { records: [], lastRkey: null },
        })
        h.registered.add("did:plc:yes")
        h.listings.queue("did:plc:m")
        await run(h)
        expect(h.listings.calls.stage[0]!.rows).toEqual([{ rkey: "a", subject: "did:plc:yes" }])
    })

    it("a failed step bumps attempts and a committed step resets them", async () => {
        let fail = false
        const pages = pagesOf(2)
        const h = harness({
            listFollows: async (pds, did, cursor) => {
                if (fail) throw new Error("down")
                return pages.listFollows(pds, did, cursor)
            },
        })
        h.registered.add("did:plc:f0")
        const row = h.listings.queue("did:plc:m")
        await run(h, { pagesPerAlarm: 2 })
        expect(row.attempts).toBe(0)
        expect(row.inProgress!.cursor).toBe("p0000")

        fail = true
        h.clock.now += 10
        await run(h, { pagesPerAlarm: 1 })
        expect(row.attempts).toBe(1)
        expect(row.inProgress!.cursor).toBe("p0000")
        expect(row.notBeforeMs).toBe(h.clock.now + 1_000)

        fail = false
        h.clock.now += 10_000
        await run(h, { pagesPerAlarm: 1 })
        expect(row.attempts).toBe(0)
        expect(row.inProgress!.cursor).toBe("p0001")
    })

    it("a step whose progress was restarted publishes nothing", async () => {
        const stale = harness()
        stale.owners.add("did:plc:x")
        stale.listings.queue("did:plc:x")
        stale.deps.verifyRepo = async () => {
            await stale.listings.index.beginListing("did:plc:x", "owner-repo", NOW, null, 0)
            return verified(["did:plc:a"])
        }
        expect(await run(stale)).toEqual(["superseded"])
        expect(stale.puts).toEqual([])
        expect(stale.listings.staging.get("did:plc:x")).toEqual([])

        const drain = harness()
        drain.listings.queue("did:plc:m", {
            inProgress: {
                kind: "mutual",
                gen: 100,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
            pages: 0,
            },
        })
        drain.listings.stage("did:plc:m", 3)
        const original = drain.listings.index.saveDrainProgress
        drain.listings.index.saveDrainProgress = async (...args) => {
            await drain.listings.index.beginListing("did:plc:m", "mutual", NOW, "p", 0)
            return original(...args)
        }
        expect(await run(drain)).toEqual(["superseded"])
        expect(drain.sweeps).toEqual([])
        expect(drain.listings.calls.completed).toEqual([])
    })

    it("an owner listing is fetched, drained, swept and completed in one alarm", async () => {
        const h = harness()
        h.owners.add("did:plc:x")
        h.listings.queue("did:plc:x")
        expect(await run(h)).toEqual(["listed"])
        expect(h.puts).toHaveLength(1)
        expect(h.sweeps).toHaveLength(1)
        expect(h.sweeps[0]!.gen).toBe(h.puts[0]!.gen)
        expect(h.listings.calls.completed[0]!.subjects).toEqual(["did:plc:swept"])
        expect(h.listings.calls.recount).toEqual(["did:plc:a", "did:plc:b"])
    })

    it("a drain that does not fit the reserve waits for the next alarm", async () => {
        const h = harness()
        h.listings.queue("did:plc:m", {
            inProgress: {
                kind: "mutual",
                gen: 1,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
            pages: 0,
            },
        })
        h.listings.stage("did:plc:m", 5_000)
        expect(await run(h)).toEqual(["in-progress"])
        expect(h.budget.spent()).toBeLessThanOrEqual(400)
        expect(h.puts.flatMap((p) => p.rkeys).length).toBeGreaterThan(2_000)
        expect(h.sweeps).toEqual([])

        const none = harness({}, 3)
        none.listings.queue("did:plc:m", {
            inProgress: {
                kind: "mutual",
                gen: 1,
                phase: "drain",
                cursor: null,
                pds: "p",
                beganAtMs: 1,
            pages: 0,
            },
        })
        none.listings.stage("did:plc:m", 10)
        expect(await run(none)).toEqual(["over-budget"])
    })

    it("followRecordsOf skips a record without a string subject", () => {
        expect(followRecordsOf(verified(["did:plc:a", null, "did:plc:b"]))).toEqual([
            { rkey: "r0000", subject: "did:plc:a" },
            { rkey: "r0002", subject: "did:plc:b" },
        ])
        const odd: VerifiedCollection = {
            rev: "r",
            records: [{ rkey: "x", cid: "c", record: { subject: 3 } }],
        }
        expect(followRecordsOf(odd)).toEqual([])
    })

    it("stale re-queue is bounded per alarm", async () => {
        const l = fakeListings({ now: NOW })
        const cfg = { relistAfterMs: 7 * 86_400_000, maxPerAlarm: 200 }
        l.setDueQueued(0)
        expect(await relistStale({ listings: l.index, nowMs: () => NOW }, cfg)).toBe(200)
        expect(l.calls.staleQueued).toEqual([{ before: NOW - cfg.relistAfterMs, limit: 200 }])
        l.setDueQueued(250)
        expect(await relistStale({ listings: l.index, nowMs: () => NOW }, cfg)).toBe(0)
        expect(l.calls.staleQueued).toHaveLength(1)
    })

    it("stale re-lists fill remaining capacity up to the cap", async () => {
        const l = fakeListings({ now: NOW })
        const cfg = { relistAfterMs: 1_000, maxPerAlarm: 200 }
        l.setDueQueued(150)
        expect(await relistStale({ listings: l.index, nowMs: () => NOW }, cfg)).toBe(50)
        expect(l.calls.staleQueued.at(-1)!.limit).toBe(50)
        l.setDueQueued(199)
        await relistStale({ listings: l.index, nowMs: () => NOW }, cfg)
        expect(l.calls.staleQueued.at(-1)!.limit).toBe(1)
    })
})

describe("follow stream gap", () => {
    const LOOKBACK = 36 * 3_600_000

    it("never connected is not a gap", () => {
        expect(followGapExceeded(null, NOW, LOOKBACK)).toBe(false)
    })

    it("a gap is judged from last_connected_at against the lookback", () => {
        expect(followGapExceeded(NOW - LOOKBACK, NOW, LOOKBACK)).toBe(false)
        expect(followGapExceeded(NOW - LOOKBACK - 1, NOW, LOOKBACK)).toBe(true)
        expect(followGapExceeded(NOW - 1_000, NOW, LOOKBACK)).toBe(false)
    })
})
