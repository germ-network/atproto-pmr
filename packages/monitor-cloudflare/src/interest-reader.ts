import type { InterestReader } from "@germ-network/atproto-pmr-core"

/**
 * The allow list as a read route sees it: the mirrored `interest` and
 * `graph_owners` tables in the D1 `graph` database, which trail the single
 * writer by at most an alarm.
 */
export function d1InterestReader(db: D1Database): InterestReader {
    return {
        async serves(did) {
            return (
                (await db.prepare("SELECT 1 AS n FROM interest WHERE did = ?").bind(did).first()) !== null
            )
        },
        async isRegistered(did) {
            return (
                (await db
                    .prepare("SELECT 1 AS n FROM interest WHERE did = ? AND registered = 1")
                    .bind(did)
                    .first()) !== null
            )
        },
        async servedGraphs(cursor, limit) {
            const { results } = await db
                .prepare(
                    "SELECT did FROM graph_owners WHERE (?1 IS NULL OR did > ?1) ORDER BY did LIMIT ?2"
                )
                .bind(cursor, limit + 1)
                .all<{ did: string }>()
            const dids = results.slice(0, limit).map((r) => r.did)
            return { dids, cursor: results.length > limit ? dids[dids.length - 1]! : null }
        },
    }
}
