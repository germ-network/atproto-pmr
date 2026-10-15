/**
 * Keeps the public `graph:<did>` projections in step with the edge index by
 * tailing its change log. Runs from the single writer's alarm, after the
 * mirror, so the standing it consults is the one the edge reads see.
 */
import {
    projectGraph,
    type FollowEdgeStore,
    type GraphChangeLog,
    type GraphChangeRow,
    type GraphProjectionWriter,
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
export async function runGraphProjector(deps: GraphProjectorDeps, limit: number): Promise<number> {
    let cursor = await deps.index.projectorCursor()
    if (cursor === null) {
        const { maxSeq } = await deps.changes.readSince(0, 1)
        cursor = await beginRebuild(deps, maxSeq)
    }
    if (cursor.kind === "rebuild") return rebuildStep(deps, cursor, limit)

    const { rows, maxSeq } = await deps.changes.readSince(cursor.seq, limit)
    const behindRetention = rows.length > 0 && rows[0]!.seq > cursor.seq + 1
    const aheadOfLog = rows.length === 0 && cursor.seq > maxSeq
    if (behindRetention || aheadOfLog) {
        return rebuildStep(deps, await beginRebuild(deps, maxSeq), limit)
    }
    return tailStep(deps, cursor.seq, rows)
}

async function beginRebuild(
    deps: GraphProjectorDeps,
    asOfSeq: number
): Promise<Extract<ProjectorCursor, { kind: "rebuild" }>> {
    const cursor = { kind: "rebuild", asOfSeq, phase: "project", page: null } as const
    await deps.index.setProjectorCursor(cursor)
    return cursor
}

async function projectOne(deps: GraphProjectorDeps, did: string): Promise<void> {
    const following = await deps.edges.following(did)
    const followers = await deps.edges.followers(did)
    await deps.projections.put(projectGraph(did, following, followers))
}

async function tailStep(
    deps: GraphProjectorDeps,
    from: number,
    rows: GraphChangeRow[]
): Promise<number> {
    const order: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
        if (!seen.has(row.did)) {
            seen.add(row.did)
            order.push(row.did)
        }
    }

    const written = new Set<string>()
    let changed = 0
    let failure: unknown = null
    for (const did of order) {
        try {
            const standing = await deps.index.mirroredGraphStanding(did)
            if (standing === "in-flight") {
                console.warn(`graph projector: mirror batch for ${did} in flight; waiting`)
                break
            }
            if (standing === "not-served") {
                await deps.projections.delete(did)
            } else {
                if (!deps.budget.take(PROJECT_STATEMENTS_PER_DID)) break
                await projectOne(deps, did)
            }
        } catch (err) {
            failure = err
            break
        }
        written.add(did)
        changed += 1
    }

    const blocked = rows.find((row) => !written.has(row.did))
    const seq = blocked === undefined ? (rows.at(-1)?.seq ?? from) : blocked.seq - 1
    if (seq > from) await deps.index.setProjectorCursor({ kind: "tail", seq })
    if (failure !== null) throw failure
    return changed
}

async function rebuildStep(
    deps: GraphProjectorDeps,
    cursor: Extract<ProjectorCursor, { kind: "rebuild" }>,
    limit: number
): Promise<number> {
    let changed = 0
    if (cursor.phase === "project") {
        // Sized to what the budget can pay, so a page always completes and its cursor is saved.
        const pageLimit = Math.min(limit, Math.floor(deps.budget.remaining / PROJECT_STATEMENTS_PER_DID))
        if (pageLimit === 0) return 0
        const page = await deps.index.servedGraphsMirrored(cursor.page, pageLimit)
        for (const did of page.dids) {
            const standing = await deps.index.mirroredGraphStanding(did)
            if (standing === "in-flight") {
                console.warn(`graph projector: mirror batch for ${did} in flight; waiting`)
                return changed
            }
            if (standing === "not-served") continue
            if (!deps.budget.take(PROJECT_STATEMENTS_PER_DID)) return changed
            await projectOne(deps, did)
            changed += 1
        }
        await deps.index.setProjectorCursor(
            page.cursor === null
                ? { ...cursor, phase: "sweep", page: null }
                : { ...cursor, page: page.cursor }
        )
        return changed
    }

    const page = await deps.projections.listDids(cursor.page, limit)
    for (const did of page.dids) {
        const standing = await deps.index.mirroredGraphStanding(did)
        if (standing === "in-flight") {
            console.warn(`graph projector: mirror batch for ${did} in flight; waiting`)
            return changed
        }
        if (standing === "not-served") {
            await deps.projections.delete(did)
            changed += 1
        }
    }
    await deps.index.setProjectorCursor(
        page.cursor === null
            ? { kind: "tail", seq: cursor.asOfSeq }
            : { ...cursor, page: page.cursor }
    )
    return changed
}
