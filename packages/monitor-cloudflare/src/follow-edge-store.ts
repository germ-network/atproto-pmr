import type { FollowEdge, FollowEdgeStore } from "@germ-network/atproto-pmr-core"
import {
    D1_ROWS_PER_STATEMENT,
    type EdgeRef,
    type EdgeWriteResult,
    type FollowEdgeWriter,
    type GraphMirrorRow,
    type GraphMirrorTransition,
    type StatementBudget,
} from "@germ-network/atproto-pmr-monitor"

/**
 * The follow-edge index's reads, over the D1 `graph` database. Both serve
 * only a DID whose graph is served (in `graph_owners`), and nothing
 * otherwise: `following(did)` its edges to subjects in `graph_holders`,
 * `followers(did)` the edges into it from followers in `graph_holders`. The
 * filters are in the query, so no caller can serve an edge outside the
 * declaration set or for a graph not served.
 */
export function d1FollowEdgeStore(db: D1Database): FollowEdgeStore {
    const served = "EXISTS (SELECT 1 FROM graph_owners WHERE did = ?1)"
    return {
        async following(did: string): Promise<FollowEdge[]> {
            const { results } = await db
                .prepare(
                    "SELECT f.follower, f.rkey, f.subject FROM follows f " +
                        "JOIN graph_holders h ON h.did = f.subject " +
                        `WHERE f.follower = ?1 AND ${served} ORDER BY f.rkey`
                )
                .bind(did)
                .all<FollowEdge>()
            return results
        },
        async followers(did: string): Promise<FollowEdge[]> {
            const { results } = await db
                .prepare(
                    "SELECT f.follower, f.rkey, f.subject FROM follows f " +
                        "JOIN graph_holders h ON h.did = f.follower " +
                        `WHERE f.subject = ?1 AND ${served} ORDER BY f.follower, f.rkey`
                )
                .bind(did)
                .all<FollowEdge>()
            return results
        },
    }
}

/** One alarm's D1 statement allowance, default 1,000 (the per-invocation query limit). */
export function statementBudget(limit: number): StatementBudget {
    let remaining = limit
    return {
        get remaining() {
            return remaining
        },
        take(count: number): boolean {
            if (count > remaining) return false
            remaining -= count
            return true
        },
    }
}

const CHANGE = "INSERT INTO graph_changes (did, reason, at_ms) "

function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
}

const placeholders = (count: number, from: number): string =>
    Array.from({ length: count }, (_, i) => `?${from + i}`).join(",")

function rowOf(r: {
    did: string
    owner: number
    holder: number
    member: number
    registered: number
}): GraphMirrorRow {
    return {
        did: r.did,
        owner: r.owner === 1,
        holder: r.holder === 1,
        member: r.member === 1,
        registered: r.registered === 1,
    }
}

const STANDING =
    "SELECT d.did AS did, " +
    "EXISTS (SELECT 1 FROM graph_owners WHERE did = d.did) AS owner, " +
    "EXISTS (SELECT 1 FROM graph_holders WHERE did = d.did) AS holder, " +
    "EXISTS (SELECT 1 FROM interest WHERE did = d.did) AS member, " +
    "COALESCE((SELECT registered FROM interest WHERE did = d.did), 0) AS registered "

/** The single writer's side of the same database, spending from `budget`. */
export function d1FollowEdgeWriter(db: D1Database, budget: StatementBudget): FollowEdgeWriter {
    /** Charge `statements` to the budget, then send them as one batch. */
    async function send(statements: D1PreparedStatement[]) {
        if (statements.length === 0) return []
        if (!budget.take(statements.length)) {
            throw new Error(`D1 statement budget exceeded (${statements.length} needed)`)
        }
        return db.batch(statements)
    }

    const subjectsOf = (result: D1Result | undefined): string[] => [
        ...new Set(((result?.results ?? []) as { subject: string }[]).map((r) => r.subject)),
    ]

    /** `(follower, rkey)` pairs as a row-value list starting at `?from`. */
    const refList = (count: number, from: number): string =>
        Array.from({ length: count }, (_, i) => `(?${from + 2 * i},?${from + 2 * i + 1})`).join(",")

    return {
        async putEdges(edges, gen) {
            const now = Date.now()
            const statements: D1PreparedStatement[] = []
            // A put that re-points an existing follow leaves its old subject's
            // followers changed too: note that subject before the upsert.
            const replaced: number[] = []
            for (const chunk of chunks(edges, D1_ROWS_PER_STATEMENT)) {
                const binds = chunk.flatMap((e) => [e.follower, e.rkey])
                const match = `(f.follower, f.rkey) IN (VALUES ${refList(chunk.length, 2)})`
                statements.push(
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.subject, 'followers', ?1 FROM follows f " +
                                `JOIN graph_holders h ON h.did = f.subject WHERE ${match}`
                        )
                        .bind(now, ...binds)
                )
                replaced.push(statements.length)
                statements.push(
                    db
                        .prepare(
                            "SELECT DISTINCT subject FROM follows WHERE (follower, rkey) IN " +
                                `(VALUES ${refList(chunk.length, 1)})`
                        )
                        .bind(...binds)
                )
            }
            for (const chunk of chunks(edges, D1_ROWS_PER_STATEMENT)) {
                const values = chunk.map((_, i) => `(?${4 * i + 1},?${4 * i + 2},?${4 * i + 3},?${4 * i + 4})`)
                statements.push(
                    db
                        .prepare(
                            "INSERT INTO follows (follower, rkey, subject, gen) VALUES " +
                                values.join(",") +
                                " ON CONFLICT (follower, rkey) DO UPDATE SET " +
                                "subject = excluded.subject, gen = excluded.gen"
                        )
                        .bind(...chunk.flatMap((e) => [e.follower, e.rkey, e.subject, gen]))
                )
            }
            const followers = [...new Set(edges.map((e) => e.follower))]
            const subjects = [...new Set(edges.map((e) => e.subject))]
            for (const chunk of chunks(followers, D1_ROWS_PER_STATEMENT)) {
                statements.push(
                    db
                        .prepare(
                            CHANGE +
                                "SELECT did, 'following', ?1 FROM graph_owners " +
                                `WHERE did IN (${placeholders(chunk.length, 2)})`
                        )
                        .bind(now, ...chunk)
                )
            }
            for (const chunk of chunks(subjects, D1_ROWS_PER_STATEMENT)) {
                statements.push(
                    db
                        .prepare(
                            CHANGE +
                                "SELECT did, 'followers', ?1 FROM graph_holders " +
                                `WHERE did IN (${placeholders(chunk.length, 2)})`
                        )
                        .bind(now, ...chunk)
                )
            }
            const results = await send(statements)
            const old = replaced.flatMap((i) => subjectsOf(results[i]))
            return { subjects: [...new Set([...subjects, ...old])] }
        },

        async deleteEdges(refs: readonly EdgeRef[]): Promise<EdgeWriteResult> {
            const now = Date.now()
            const statements: D1PreparedStatement[] = []
            const deletes: number[] = []
            for (const chunk of chunks(refs, D1_ROWS_PER_STATEMENT)) {
                const binds = chunk.flatMap((r) => [r.follower, r.rkey])
                const match = `(f.follower, f.rkey) IN (VALUES ${refList(chunk.length, 2)})`
                statements.push(
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.follower, 'following', ?1 FROM follows f " +
                                `JOIN graph_owners o ON o.did = f.follower WHERE ${match}`
                        )
                        .bind(now, ...binds),
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.subject, 'followers', ?1 FROM follows f " +
                                `JOIN graph_holders h ON h.did = f.subject WHERE ${match}`
                        )
                        .bind(now, ...binds)
                )
                deletes.push(statements.length)
                statements.push(
                    db
                        .prepare(
                            "DELETE FROM follows WHERE (follower, rkey) IN " +
                                `(VALUES ${refList(chunk.length, 1)}) RETURNING subject`
                        )
                        .bind(...binds)
                )
            }
            const results = await send(statements)
            return { subjects: [...new Set(deletes.flatMap((i) => subjectsOf(results[i])))] }
        },

        async sweep(follower, gen) {
            return removeFollowerEdges(follower, gen)
        },

        async pruneFollower(follower) {
            return removeFollowerEdges(follower)
        },

        async mirror(transitions: readonly GraphMirrorTransition[]): Promise<EdgeWriteResult> {
            const now = Date.now()
            const statements: D1PreparedStatement[] = []
            const prunes: number[] = []
            for (const { now: s } of transitions) {
                const owner = s.owner ? 1 : 0
                const holder = s.holder ? 1 : 0
                const member = s.member ? 1 : 0
                // Each statement binds up to the highest index it uses, so some
                // take a prefix; an unused index inside the prefix is harmless.
                const didBind = [s.did, now, owner, holder, member] as const
                const ownerNow = "EXISTS (SELECT 1 FROM graph_owners WHERE did = ?1)"
                const holderNow = "EXISTS (SELECT 1 FROM graph_holders WHERE did = ?1)"
                const memberNow = "EXISTS (SELECT 1 FROM interest WHERE did = ?1)"
                const flagMoved = `(?3 <> ${ownerNow} OR ?4 <> ${holderNow})`
                const pruning = `((${ownerNow} AND ?3 = 0) OR (${memberNow} AND ?5 = 0))`
                statements.push(
                    db
                        .prepare(
                            CHANGE +
                                "SELECT ?1, CASE WHEN ?3 = 1 THEN 'served-add' ELSE 'served-remove' END, ?2 " +
                                `WHERE ?3 <> ${ownerNow}`
                        )
                        .bind(...didBind.slice(0, 3)),
                    db
                        .prepare(
                            CHANGE +
                                "SELECT ?1, CASE WHEN ?4 = 1 THEN 'holder-add' ELSE 'holder-remove' END, ?2 " +
                                `WHERE ?4 <> ${holderNow}`
                        )
                        .bind(...didBind.slice(0, 4)),
                    // Whoever follows this DID reads it differently now, and
                    // so does every holder it follows.
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.follower, 'following', ?2 FROM follows f " +
                                `JOIN graph_owners o ON o.did = f.follower WHERE f.subject = ?1 AND ${flagMoved}`
                        )
                        .bind(...didBind.slice(0, 4)),
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.subject, 'followers', ?2 FROM follows f " +
                                `JOIN graph_holders h ON h.did = f.subject WHERE f.follower = ?1 AND ${flagMoved}`
                        )
                        .bind(...didBind.slice(0, 4)),
                    // A prune takes the DID's own edges away: holder subjects read their
                    // followers differently, unless the fan-out above already said so.
                    // A DID no longer served already has its served-remove row.
                    db
                        .prepare(
                            CHANGE +
                                "SELECT DISTINCT f.subject, 'followers', ?2 FROM follows f " +
                                `JOIN graph_holders h ON h.did = f.subject WHERE f.follower = ?1 AND ${pruning} AND NOT ${flagMoved}`
                        )
                        .bind(...didBind),
                    db
                        .prepare(
                            CHANGE +
                                `SELECT ?1, 'following', ?2 WHERE ?3 = 1 AND ${ownerNow} AND ${pruning}`
                        )
                        .bind(...didBind)
                )
                prunes.push(statements.length)
                statements.push(
                    db
                        .prepare(
                            `DELETE FROM follows WHERE follower = ?1 AND ${pruning} RETURNING subject`
                        )
                        .bind(...didBind),
                    owner === 1
                        ? db.prepare("INSERT OR IGNORE INTO graph_owners (did) VALUES (?1)").bind(s.did)
                        : db.prepare("DELETE FROM graph_owners WHERE did = ?1").bind(s.did),
                    holder === 1
                        ? db.prepare("INSERT OR IGNORE INTO graph_holders (did) VALUES (?1)").bind(s.did)
                        : db.prepare("DELETE FROM graph_holders WHERE did = ?1").bind(s.did),
                    member === 1
                        ? db
                              .prepare(
                                  "INSERT INTO interest (did, registered) VALUES (?1, ?2) " +
                                      "ON CONFLICT (did) DO UPDATE SET registered = excluded.registered"
                              )
                              .bind(s.did, s.registered ? 1 : 0)
                        : db.prepare("DELETE FROM interest WHERE did = ?1").bind(s.did)
                )
            }
            const results = await send(statements)
            return { subjects: [...new Set(prunes.flatMap((i) => subjectsOf(results[i])))] }
        },

        async listMirrored(cursor, limit) {
            if (!budget.take(1)) throw new Error("D1 statement budget exceeded (1 needed)")
            const { results } = await db
                .prepare(
                    STANDING +
                        "FROM (SELECT did FROM graph_owners UNION SELECT did FROM graph_holders " +
                        "UNION SELECT did FROM interest) d WHERE (?1 IS NULL OR d.did > ?1) " +
                        "ORDER BY d.did LIMIT ?2"
                )
                .bind(cursor, limit + 1)
                .all<Parameters<typeof rowOf>[0]>()
            const page = results.slice(0, limit)
            return {
                rows: page.map(rowOf),
                cursor: results.length > limit ? page[page.length - 1]!.did : null,
            }
        },

        async mirroredOf(dids) {
            const out = new Map<string, GraphMirrorRow>()
            for (const chunk of chunks([...new Set(dids)], 50)) {
                if (!budget.take(1)) throw new Error("D1 statement budget exceeded (1 needed)")
                const { results } = await db
                    .prepare(
                        STANDING +
                            `FROM (SELECT did FROM graph_owners UNION SELECT did FROM graph_holders ` +
                            `UNION SELECT did FROM interest) d WHERE d.did IN (${placeholders(chunk.length, 1)})`
                    )
                    .bind(...chunk)
                    .all<Parameters<typeof rowOf>[0]>()
                for (const r of results) out.set(r.did, rowOf(r))
            }
            return out
        },

        async followersOf(subjects) {
            const out = new Map<string, string[]>()
            for (const chunk of chunks([...new Set(subjects)], 50)) {
                if (!budget.take(1)) throw new Error("D1 statement budget exceeded (1 needed)")
                const { results } = await db
                    .prepare(
                        "SELECT subject, follower FROM follows " +
                            `WHERE subject IN (${placeholders(chunk.length, 1)})`
                    )
                    .bind(...chunk)
                    .all<{ subject: string; follower: string }>()
                for (const r of results) {
                    const list = out.get(r.subject) ?? []
                    list.push(r.follower)
                    out.set(r.subject, list)
                }
            }
            return out
        },

        async pruneChanges(beforeMs, limit) {
            if (!budget.take(1)) throw new Error("D1 statement budget exceeded (1 needed)")
            // The newest row stays so MAX(seq) never goes back.
            const result = await db
                .prepare(
                    "DELETE FROM graph_changes WHERE seq IN (" +
                        "SELECT seq FROM graph_changes WHERE seq <= " +
                        "(SELECT MAX(seq) FROM graph_changes WHERE at_ms < ?1) AND seq < " +
                        "(SELECT MAX(seq) FROM graph_changes) ORDER BY seq LIMIT ?2)"
                )
                .bind(beforeMs, limit)
                .run()
            return result.meta.changes
        },
    }

    async function removeFollowerEdges(follower: string, gen?: number): Promise<EdgeWriteResult> {
        const now = Date.now()
        // The change rows number ?1 follower, ?2 now, ?3 the generation to sweep
        // below (sweep only); the DELETE numbers its own binds.
        const stale = gen === undefined ? "" : " AND gen < ?3"
        const staleF = gen === undefined ? "" : " AND f.gen < ?3"
        const binds = gen === undefined ? [follower, now] : [follower, now, gen]
        const results = await send([
            db
                .prepare(
                    CHANGE +
                        "SELECT did, 'following', ?2 FROM graph_owners WHERE did = ?1 " +
                        `AND EXISTS (SELECT 1 FROM follows WHERE follower = ?1${stale})`
                )
                .bind(...binds),
            db
                .prepare(
                    CHANGE +
                        "SELECT DISTINCT f.subject, 'followers', ?2 FROM follows f " +
                        `JOIN graph_holders h ON h.did = f.subject WHERE f.follower = ?1${staleF}`
                )
                .bind(...binds),
            db
                .prepare(
                    gen === undefined
                        ? "DELETE FROM follows WHERE follower = ?1 RETURNING subject"
                        : "DELETE FROM follows WHERE follower = ?1 AND gen < ?2 RETURNING subject"
                )
                .bind(...(gen === undefined ? [follower] : [follower, gen])),
        ])
        return { subjects: subjectsOf(results[2]) }
    }
}
