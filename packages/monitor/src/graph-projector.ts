/**
 * Keeps the public `graph:<did>` projections in step with the edge index by
 * tailing its change log. Runs from the single writer's alarm, after the
 * mirror, so the standing it consults is the one the edge reads see.
 */
import type {
    FollowEdgeStore,
    GraphChangeLog,
    GraphProjectionWriter,
} from "@germ-network/atproto-pmr-core"
import type { StatementBudget } from "./storage"

/**
 * Where the projector is. `tail`: every row up to `seq` has its projection
 * written. `rebuild`: the cursor fell behind retention (or never existed),
 * so every served graph is re-projected (`project`), then every held
 * projection no longer served is deleted (`sweep`); tailing resumes from
 * `asOfSeq`, the log's high-water mark when the rebuild began.
 */
export type ProjectorCursor =
    | { kind: "tail"; seq: number }
    | { kind: "rebuild"; asOfSeq: number; phase: "project" | "sweep"; page: string | null }

export interface GraphProjectorIndex {
    /** Null before the first run, which starts with a rebuild. */
    projectorCursor(): Promise<ProjectorCursor | null>
    setProjectorCursor(cursor: ProjectorCursor): Promise<void>
    /**
     * `did`'s graph standing as last mirrored to the edge index
     * (`graph_mirrored`), not the single writer's own, which may lead it: the
     * edge reads return nothing for a graph the index does not serve, and
     * that must not be projected as empty. `in-flight`: a mirror batch for it
     * may have committed without being recorded, so neither answer is known
     * and the projector waits for the next alarm, since the re-sent batch
     * writes no second change row.
     */
    mirroredGraphStanding(did: string): Promise<MirroredGraphStanding>
    /**
     * The graphs a rebuild projects, paged by DID: mirrored owners and
     * in-flight rows (which then stop the pass until recorded).
     */
    servedGraphsMirrored(
        cursor: string | null,
        limit: number
    ): Promise<{ dids: string[]; cursor: string | null }>
}

export type MirroredGraphStanding = "served" | "not-served" | "in-flight"

export interface GraphProjectorDeps {
    index: GraphProjectorIndex
    changes: GraphChangeLog
    edges: FollowEdgeStore
    projections: GraphProjectionWriter
    budget: StatementBudget
}

/** D1 statements a projected DID costs: its following and followers reads. */
export const PROJECT_STATEMENTS_PER_DID = 2

/**
 * One pass: tails up to `limit` change rows (or advances a rebuild by up to
 * `limit` DIDs), projecting each named DID once whose graph is served and
 * deleting the projection of each that is not. The cursor advances only
 * past rows whose writes completed, never past what the budget paid for,
 * and never past an in-flight DID. Runs after the mirror and before the
 * change-log prune, which keeps the newest row, so a cursor at the
 * high-water mark never reads an emptied log as a gap. Returns how many
 * DIDs were projected or deleted.
 */
export async function runGraphProjector(
    _deps: GraphProjectorDeps,
    _limit: number
): Promise<number> {
    throw new Error("not implemented")
}
