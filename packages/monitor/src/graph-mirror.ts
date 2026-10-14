/**
 * The edge index's copy of the single writer's standing per DID: whose graph
 * is served (`graph_owners`), who holds a declaration (`graph_holders`), and
 * who is in interest (`interest`). Read routes consult the copy, never the
 * single writer, so it is pushed from the alarm, with change rows.
 */
import type { FollowEdgeWriter, GraphMirrorRow, GraphMirrorTransition } from "./storage"

/** How long `graph_changes` rows are kept; a consumer further behind rebuilds. */
export const GRAPH_CHANGE_RETENTION_MS = 7 * 86_400_000

/**
 * The single writer's side of the mirror: its standing per DID, and the
 * standing last mirrored for it (the DO's `graph_mirrored` table).
 */
export interface GraphMirrorIndex {
    /**
     * Up to `limit` DIDs whose standing differs from what was last mirrored,
     * a full diff in both directions: a DID known only to `graph_mirrored`
     * (its `holder_state` and `interest` rows dropped by a leave) comes back
     * with an all-false `now`.
     */
    dueMirror(limit: number): Promise<GraphMirrorTransition[]>
    /**
     * Record `rows` as mirrored, once their batch committed: exactly the rows
     * given, never re-read, so a standing that changed during the D1 await
     * is still due next time. An all-false row drops the DID.
     */
    markMirrored(rows: readonly GraphMirrorRow[]): Promise<void>
    /** `did`'s standing now; all false for a DID the single writer does not know. */
    standingOf(did: string): Promise<GraphMirrorRow>
    /** The last-mirrored rows, paged by DID, for the daily reconcile. */
    mirroredPage(
        cursor: string | null,
        limit: number
    ): Promise<{ rows: GraphMirrorRow[]; cursor: string | null }>
}

export interface GraphMirrorDeps {
    index: GraphMirrorIndex
    edges: FollowEdgeWriter
    nowMs(): number
}

/**
 * Mirror up to `limit` changed DIDs in one writer batch, then record them as
 * mirrored. A DID whose graph stops being served, or that leaves interest,
 * has its edges pruned in that batch. Returns how many were mirrored.
 */
export async function mirrorGraph(deps: GraphMirrorDeps, limit: number): Promise<number> {
    const transitions = await deps.index.dueMirror(limit)
    if (transitions.length === 0) return 0
    await deps.edges.mirror(transitions)
    await deps.index.markMirrored(transitions.map((t) => t.now))
    return transitions.length
}

/** Where the daily reconcile resumes: which side it is paging, and after which DID. */
export interface MirrorReconcileCursor {
    /** `single-writer`: D1 checked against the single writer's mirrored rows; `d1`: the reverse. */
    side: "single-writer" | "d1"
    after: string | null
}

/**
 * The daily repair, with the single writer as the source of truth, in both
 * directions: a DID it records as mirrored that D1 lacks or holds
 * differently, and a DID D1 holds that it does not, are each re-mirrored
 * from what D1 actually has. Resumable through the cursor; returns the next
 * one, or null once the pass is done.
 */
export async function reconcileGraphMirror(
    deps: GraphMirrorDeps,
    cursor: MirrorReconcileCursor | null,
    limit: number
): Promise<MirrorReconcileCursor | null> {
    const at = cursor ?? { side: "single-writer" as const, after: null }
    const transitions: GraphMirrorTransition[] = []
    let next: MirrorReconcileCursor | null
    if (at.side === "single-writer") {
        const page = await deps.index.mirroredPage(at.after, limit)
        const held = await deps.edges.mirroredOf(page.rows.map((r) => r.did))
        for (const recorded of page.rows) {
            const actual = held.get(recorded.did) ?? null
            if (actual === null || !sameStanding(actual, recorded)) {
                transitions.push({ now: await deps.index.standingOf(recorded.did), mirrored: actual })
            }
        }
        next = { side: page.cursor === null ? "d1" : "single-writer", after: page.cursor }
    } else {
        const page = await deps.edges.listMirrored(at.after, limit)
        for (const actual of page.rows) {
            const now = await deps.index.standingOf(actual.did)
            if (!sameStanding(actual, now)) transitions.push({ now, mirrored: actual })
        }
        next = page.cursor === null ? null : { side: "d1", after: page.cursor }
    }
    if (transitions.length > 0) {
        await deps.edges.mirror(transitions)
        await deps.index.markMirrored(transitions.map((t) => t.now))
    }
    return next
}

function sameStanding(a: GraphMirrorRow, b: GraphMirrorRow): boolean {
    return (
        a.owner === b.owner &&
        a.holder === b.holder &&
        a.member === b.member &&
        a.registered === b.registered
    )
}

/**
 * Delete up to `limit` change rows older than the retention, oldest first;
 * returns how many, so a large backlog is pruned across alarms.
 */
export async function pruneGraphChanges(
    deps: { edges: Pick<FollowEdgeWriter, "pruneChanges">; nowMs(): number },
    limit: number,
    retentionMs: number = GRAPH_CHANGE_RETENTION_MS
): Promise<number> {
    return deps.edges.pruneChanges(deps.nowMs() - retentionMs, limit)
}
