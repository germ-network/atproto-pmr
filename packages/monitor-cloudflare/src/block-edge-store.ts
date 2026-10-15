import type { BlockEdge, BlockEdgeStore } from "@germ-network/atproto-pmr-core"
import {
    D1_ROWS_PER_STATEMENT,
    type BlockEdgeWriter,
    type StatementBudget,
} from "@germ-network/atproto-pmr-monitor"

/** What a read needs of D1: a database, or a session a replica may serve. */
export type D1Reader = Pick<D1Database, "prepare" | "batch">

// Compile-time check that a `withSession()` session can stand in for the database.
export const sessionIsReader = (session: D1DatabaseSession): D1Reader => session

/**
 * The block index's reads, over the D1 `graph` database. `ownBlocks` returns
 * a DID's blocks only while its graph is served (in `graph_owners`), null
 * otherwise; there is no read that lists another DID's blocks. `isBlocked`
 * applies the keep rule in the query: a block counts when its blocker is a
 * served owner or its subject is registered, so rows left from before a
 * subject deregistered read as not blocked.
 */
export function d1BlockEdgeStore(db: D1Reader): BlockEdgeStore {
    return {
        async ownBlocks(did: string): Promise<BlockEdge[] | null> {
            const [served, rows] = await db.batch<BlockEdge & { served: number }>([
                db
                    .prepare("SELECT EXISTS (SELECT 1 FROM graph_owners WHERE did = ?1) AS served")
                    .bind(did),
                db
                    .prepare("SELECT blocker, rkey, subject FROM blocks WHERE blocker = ?1 ORDER BY rkey")
                    .bind(did),
            ])
            if (served!.results[0]!.served !== 1) return null
            return rows!.results
        },
        async isBlocked(blocker: string, subject: string): Promise<boolean> {
            const row = await db
                .prepare(
                    "SELECT 1 AS hit FROM blocks WHERE blocker = ?1 AND subject = ?2 AND (" +
                        "EXISTS (SELECT 1 FROM graph_owners WHERE did = ?1) OR " +
                        "EXISTS (SELECT 1 FROM interest WHERE did = ?2 AND registered = 1)) LIMIT 1"
                )
                .bind(blocker, subject)
                .first()
            return row !== null
        },
        async blockersOf(subject: string, blockers: readonly string[]): Promise<Set<string>> {
            if (blockers.length === 0) return new Set()
            const list = blockers.map((_, i) => `?${i + 2}`).join(",")
            const { results } = await db
                .prepare(
                    "SELECT blocker FROM blocks WHERE subject = ?1 AND blocker IN (" +
                        list +
                        ") AND (EXISTS (SELECT 1 FROM graph_owners WHERE did = blocks.blocker) OR " +
                        "EXISTS (SELECT 1 FROM interest WHERE did = ?1 AND registered = 1))"
                )
                .bind(subject, ...blockers)
                .all<{ blocker: string }>()
            return new Set(results.map((r) => r.blocker))
        },
    }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
}

/** The single writer's block writes, spending from `budget`. */
export function d1BlockEdgeWriter(db: D1Database, budget: StatementBudget): BlockEdgeWriter {
    /** Charge `statements` to the budget, then send them as one batch. */
    async function send(statements: D1PreparedStatement[]): Promise<void> {
        if (statements.length === 0) return
        if (!budget.take(statements.length)) {
            throw new Error(`D1 statement budget exceeded (${statements.length} needed)`)
        }
        await db.batch(statements)
    }

    return {
        async putBlocks(blocks, gen) {
            await send(
                chunks(blocks, D1_ROWS_PER_STATEMENT).map((chunk) => {
                    const values = chunk.map((_, i) => `(?${4 * i + 1},?${4 * i + 2},?${4 * i + 3},?${4 * i + 4})`)
                    return db
                        .prepare(
                            "INSERT INTO blocks (blocker, rkey, subject, gen) VALUES " +
                                values.join(",") +
                                " ON CONFLICT (blocker, rkey) DO UPDATE SET " +
                                "subject = excluded.subject, gen = excluded.gen"
                        )
                        .bind(...chunk.flatMap((b) => [b.blocker, b.rkey, b.subject, gen]))
                })
            )
        },

        async deleteBlocks(refs) {
            await send(
                chunks(refs, D1_ROWS_PER_STATEMENT).map((chunk) => {
                    const pairs = chunk.map((_, i) => `(?${2 * i + 1},?${2 * i + 2})`)
                    return db
                        .prepare(`DELETE FROM blocks WHERE (blocker, rkey) IN (VALUES ${pairs.join(",")})`)
                        .bind(...chunk.flatMap((r) => [r.blocker, r.rkey]))
                })
            )
        },

        async sweepBlocks(blocker, gen) {
            await send([
                db.prepare("DELETE FROM blocks WHERE blocker = ?1 AND gen < ?2").bind(blocker, gen),
            ])
        },
    }
}
