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
export async function mirrorGraph(_deps: GraphMirrorDeps, _limit: number): Promise<number> {
    throw new Error("not implemented")
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
    _deps: GraphMirrorDeps,
    _cursor: MirrorReconcileCursor | null,
    _limit: number
): Promise<MirrorReconcileCursor | null> {
    throw new Error("not implemented")
}

/**
 * Delete up to `limit` change rows older than the retention, oldest first;
 * returns how many, so a large backlog is pruned across alarms.
 */
export async function pruneGraphChanges(
    _deps: { edges: Pick<FollowEdgeWriter, "pruneChanges">; nowMs(): number },
    _limit: number,
    _retentionMs: number = GRAPH_CHANGE_RETENTION_MS
): Promise<number> {
    throw new Error("not implemented")
}
