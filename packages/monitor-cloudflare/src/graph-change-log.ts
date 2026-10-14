import type { GraphChangeLog, GraphChangeReason, GraphChangeRow } from "@germ-network/atproto-pmr-core"

interface ChangeRow {
    seq: number
    did: string
    reason: GraphChangeReason
    at_ms: number
}

/**
 * `graph_changes` over the D1 `graph` database. `readSince` reads the page
 * and the log's high-water mark in one `db.batch`, so the two agree.
 * `maxSeq` is the AUTOINCREMENT high-water mark (`sqlite_sequence`), not
 * `MAX(seq)`, so it never goes back when the prune empties the log. Where
 * `sqlite_sequence` cannot be read, `MAX(seq)` stands in: the prune keeps the
 * newest row, so it is monotonic too.
 *
 * Seqs are contiguous: AUTOINCREMENT rolls back with its batch, and the
 * prune deletes only from the oldest end. A first row past `seq + 1`
 * therefore means the reader fell behind the retention and must rebuild.
 */
export function d1GraphChangeLog(db: D1Database): GraphChangeLog {
    return {
        async readSince(seq, limit) {
            const page = () =>
                db
                    .prepare(
                        "SELECT seq, did, reason, at_ms FROM graph_changes " +
                            "WHERE seq > ?1 ORDER BY seq LIMIT ?2"
                    )
                    .bind(seq, limit)
            let results: D1Result[]
            try {
                results = await db.batch([
                    page(),
                    db.prepare("SELECT seq AS max FROM sqlite_sequence WHERE name = 'graph_changes'"),
                ])
            } catch {
                results = await db.batch([page(), db.prepare("SELECT MAX(seq) AS max FROM graph_changes")])
            }
            const rows = (results[0]!.results as ChangeRow[]).map(
                (r): GraphChangeRow => ({ seq: r.seq, did: r.did, reason: r.reason, atMs: r.at_ms })
            )
            const max = (results[1]!.results as { max: number | null }[])[0]?.max
            return { rows, maxSeq: max ?? 0 }
        },
    }
}
