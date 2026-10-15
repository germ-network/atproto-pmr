/**
 * Shared scaffolding for the listing specs: an object under either policy, the
 * listing step run directly with a fresh statement budget, D1 readers, and
 * stand-ins for the object's network seams.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import {
    runListings,
    type FetchedRepo,
    type FollowBackfillConfig,
    type FollowBackfillDeps,
    type FollowPage,
    type FollowRecord,
    type ListingOutcome,
    type StatementBudget,
} from "@germ-network/atproto-pmr-monitor"
import type { VerifiedCollections } from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"

export const testEnv = env as unknown as MonitorEnv & {
    graph: D1Database
    pmrDirectory: KVNamespace
    ingest: DurableObjectNamespace<MonitorIngest>
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
export const db = testEnv.graph
export type Stub = DurableObjectStub<MonitorIngest>

let n = 0
export const registeredStub = (label: string): Stub => {
    n += 1
    return testEnv.ingestRegistered.get(testEnv.ingestRegistered.idFromName(`${label}-${n}`))
}
export const everyoneStub = (label: string): Stub => {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`${label}-${n}`))
}
export const inObj = <R>(s: Stub, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(s, (obj) => fn(obj as MonitorIngest))

export const sql = (obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    obj.ctx.storage.sql.exec(query, ...binds)
export const rowsOf = <T>(obj: MonitorIngest, query: string, ...binds: unknown[]) =>
    sql(obj, query, ...binds).toArray() as T[]

export async function all<T>(query: string, ...binds: unknown[]): Promise<T[]> {
    return (await db.prepare(query).bind(...binds).all<T>()).results
}
export const blocks = () =>
    all<{ blocker: string; rkey: string; subject: string; gen: number }>(
        "SELECT blocker, rkey, subject, gen FROM blocks ORDER BY blocker, rkey"
    )
export const blocksOf = (blocker: string) =>
    all<{ rkey: string; subject: string; gen: number }>(
        "SELECT rkey, subject, gen FROM blocks WHERE blocker = ? ORDER BY rkey",
        blocker
    )
export const follows = () =>
    all<{ follower: string; rkey: string; subject: string; gen: number }>(
        "SELECT follower, rkey, subject, gen FROM follows ORDER BY follower, rkey"
    )
export const followsOf = (follower: string) =>
    all<{ rkey: string; subject: string; gen: number }>(
        "SELECT rkey, subject, gen FROM follows WHERE follower = ? ORDER BY rkey",
        follower
    )
export const putEdge = (follower: string, rkey: string, subject: string, gen = 1) =>
    db
        .prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, ?, ?, ?)")
        .bind(follower, rkey, subject, gen)
        .run()
export const clearGraph = () =>
    db.batch(
        ["follows", "blocks", "graph_owners", "graph_holders", "interest", "graph_changes"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )

type Priv = {
    listingDeps(
        edges: FollowBackfillDeps["edges"],
        budget: StatementBudget,
        tally?: unknown
    ): FollowBackfillDeps
    listingConfig(): FollowBackfillConfig
    runGraphSteps(): Promise<void>
    seedListings(): void
    requeueOnGap(nowMs: number): void
    env: MonitorEnv
}
export const priv = (obj: MonitorIngest) => obj as unknown as Priv & Record<string, unknown>

export function setEnv(obj: MonitorIngest, overrides: Record<string, string>): void {
    ;(obj as unknown as { env: unknown }).env = { ...obj.env, ...overrides }
}

/** One listing step with its own budget, as one alarm would run it. */
export async function step(
    obj: MonitorIngest,
    options: {
        budget?: StatementBudget
        config?: Partial<FollowBackfillConfig>
        wrapEdges?: (edges: FollowBackfillDeps["edges"]) => FollowBackfillDeps["edges"]
    } = {}
): Promise<ListingOutcome[]> {
    const budget = options.budget ?? statementBudget(400)
    const edges = d1FollowEdgeWriter(db, budget)
    const deps = priv(obj).listingDeps(options.wrapEdges?.(edges) ?? edges, budget)
    return runListings(deps, { ...priv(obj).listingConfig(), ...options.config })
}

/** Steps until nothing is left in progress or queued and due; returns every step's outcomes. */
export async function drainAll(
    obj: MonitorIngest,
    options: Parameters<typeof step>[1] = {},
    max = 30
): Promise<ListingOutcome[][]> {
    const outcomes: ListingOutcome[][] = []
    for (let i = 0; i < max; i++) {
        const out = await step(obj, options)
        outcomes.push(out)
        if (!out.some((o) => o === "in-progress" || o === "over-budget")) break
    }
    return outcomes
}

export const queueRow = (obj: MonitorIngest, did: string) =>
    rowsOf<{
        queued_at: number
        attempts: number
        not_before: number
        timeouts: number
        permanent_failures: number
        unlistable: number
        low_priority: number
    }>(obj, "SELECT * FROM listing_requeue WHERE did = ?", did)[0]
export const listingRow = (obj: MonitorIngest, did: string) =>
    rowsOf<Record<string, string | number | null>>(obj, "SELECT * FROM listings WHERE did = ?", did)[0]
export const queuedDids = (obj: MonitorIngest) =>
    rowsOf<{ did: string }>(obj, "SELECT did FROM listing_requeue ORDER BY did").map((r) => r.did)
export const stagedCount = (obj: MonitorIngest, did?: string) =>
    rowsOf<{ n: number }>(
        obj,
        did === undefined
            ? "SELECT COUNT(*) AS n FROM listing_stage"
            : "SELECT COUNT(*) AS n FROM listing_stage WHERE did = ?",
        ...(did === undefined ? [] : [did])
    )[0]!.n
export const meta = (obj: MonitorIngest, k: string) =>
    rowsOf<{ v: string }>(obj, "SELECT v FROM meta WHERE k = ?", k)[0]?.v
export const ready = (obj: MonitorIngest) => sql(obj, "UPDATE listing_requeue SET not_before = 0")

export const recountQueue = (obj: MonitorIngest) =>
    rowsOf<{ did: string }>(obj, "SELECT did FROM recount_queue ORDER BY did").map((r) => r.did)

export const create = (obj: MonitorIngest, follower: string, rkey: string, subject: string) =>
    obj.logEdgeOp({ collection: "follow", kind: "create", follower, rkey, subject, rev: "r", cursor: "1" }, "1")
export const del = (obj: MonitorIngest, follower: string, rkey: string) =>
    obj.logEdgeOp({ collection: "follow", kind: "delete", follower, rkey, rev: "r", cursor: "1" }, "1")

export const rkeyOf = (i: number) => `r${String(i).padStart(6, "0")}`
export const entriesOf = (count: number, subjectOf = (i: number) => `did:plc:s${i}`) =>
    Array.from({ length: count }, (_, i): FollowRecord => ({ rkey: rkeyOf(i), subject: subjectOf(i) }))

/** What the stand-in network saw. */
export interface Net {
    repoFetches: string[]
    resolves: string[]
    pages: { did: string; cursor: string | null; collection: "follow" | "block" }[]
}

/**
 * Stand in for the object's network seams. `repos` answers getRepo (the
 * verifier returns its follow records, or throws what the entry holds),
 * `lists` answers `listRecords` follow pages `pageSize` at a time in rkey
 * order; `blockRepos` and `blockLists` are the same for blocks.
 */
export function stubNet(
    obj: MonitorIngest,
    options: {
        repos?: Record<string, FollowRecord[] | Error | (() => Promise<FollowRecord[]>)>
        lists?: Record<string, FollowRecord[] | Error>
        blockRepos?: Record<string, FollowRecord[]>
        blockLists?: Record<string, FollowRecord[] | Error>
        pageSize?: number
        pageDelayMs?: number
    }
): Net {
    const net: Net = { repoFetches: [], resolves: [], pages: [] }
    const o = obj as unknown as Record<string, unknown>
    const pending = new Map<AsyncIterable<Uint8Array>, string>()
    o.fetchRepo = async (did: string): Promise<FetchedRepo> => {
        net.repoFetches.push(did)
        const car = (async function* () {})()
        pending.set(car, did)
        return {
            car,
            signingKey: "zKey",
            source: "https://pds.invalid",
            didDocument: { document: { id: did } as never, fetchedAtMs: 0 },
        }
    }
    o.verifyRepo = async (
        car: AsyncIterable<Uint8Array>,
        expected: { did: string; maxRecords?: Record<string, number> }
    ): Promise<VerifiedCollections> => {
        const answer = options.repos?.[expected.did] ?? []
        const found = answer instanceof Error ? answer : typeof answer === "function" ? await answer() : answer
        if (found instanceof Error) throw found
        const blocks = options.blockRepos?.[expected.did] ?? []
        const { RepoCollectionError } = await import("@germ-network/atproto-pmr-core")
        for (const [collection, list] of [
            ["app.bsky.graph.follow", found],
            ["app.bsky.graph.block", blocks],
        ] as const) {
            const cap = expected.maxRecords?.[collection]
            if (cap !== undefined && list.length > cap) {
                throw new RepoCollectionError("record-cap-exceeded", "too many records")
            }
        }
        pending.delete(car)
        const records = (list: FollowRecord[]) =>
            list.map((f) => ({ rkey: f.rkey, cid: "bafy", record: { subject: f.subject } }))
        return {
            rev: "r",
            records: new Map([
                ["app.bsky.graph.follow", records(found)],
                ["app.bsky.graph.block", records(blocks)],
            ]),
        }
    }
    o.resolvePds = async (did: string) => {
        net.resolves.push(did)
        if (options.pageDelayMs) await new Promise((r) => setTimeout(r, options.pageDelayMs))
        return {
            pds: "https://pds.invalid",
            didDocument: { document: { id: did }, fetchedAtMs: Date.now() },
        }
    }
    o.listRecords = async (
        _pds: string,
        did: string,
        collection: "follow" | "block",
        cursor: string | null
    ): Promise<FollowPage> => {
        net.pages.push({ did, cursor, collection })
        if (options.pageDelayMs) await new Promise((r) => setTimeout(r, options.pageDelayMs))
        const answer = (collection === "follow" ? options.lists : options.blockLists)?.[did] ?? []
        if (answer instanceof Error) throw answer
        const sorted = [...answer].sort((a, b) => (a.rkey < b.rkey ? -1 : 1))
        const rest = cursor === null ? sorted : sorted.filter((r) => r.rkey > cursor)
        const page = rest.slice(0, options.pageSize ?? 100)
        return { records: page, lastRkey: page.length === 0 ? null : page[page.length - 1]!.rkey }
    }
    return net
}

/** One alarm with the connect stages failing, the rest running. */
export async function alarm(s: Stub) {
    await inObj(s, (obj) => (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog())
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
    try {
        await runDurableObjectAlarm(s)
    } catch (err) {
        if (!/did not upgrade/.test(String(err))) throw err
    } finally {
        globalThis.fetch = original
    }
}
