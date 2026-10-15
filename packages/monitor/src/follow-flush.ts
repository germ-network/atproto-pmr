/**
 * Draining the live follow log into the edge index, and keeping
 * `owner_followers` (and so a followee's place in interest) in step with
 * every committed edge write.
 *
 * Re-counts go through a queue in the single writer: every committed write
 * enqueues the subjects it touched in the same step that records the write
 * as done (the `edge_ops` drop, `markMirrored`, a listing's completion), and
 * a separate step drains the queue under the statement budget. So a re-count
 * that does not fit this alarm is neither lost nor a reason to re-apply the
 * write.
 */
import type { EdgeOp } from "./follow-stream"
import {
    D1_ROWS_PER_STATEMENT,
    type BlockEdgeWriter,
    type BlockRef,
    type EdgeRef,
    type FollowEdgeWriter,
    type InterestIndex,
    type StatementBudget,
} from "./storage"
import type { BlockEdge, FollowEdge } from "@germ-network/atproto-pmr-core"

/** The flush's view of the single writer's `edge_ops` log. */
export interface EdgeOpsIndex {
    /** Up to `limit` ops, oldest `seq` first. */
    edgeOps(limit: number): Promise<EdgeOp[]>
    /**
     * Once every writer batch for a read prefix committed: drop ops with
     * `seq <= throughSeq` and enqueue `subjects` for re-count, in one step.
     * `throughSeq` is the largest seq read, never the log's current maximum:
     * the stream appends during the D1 await.
     */
    dropEdgeOps(throughSeq: number, subjects: readonly string[]): Promise<void>
    /** The newest listing generation; a flushed create is written at it. */
    currentGen(): Promise<number>
}

/** A queued subject, with the stamp that identifies this queueing of it. */
export interface QueuedRecount {
    did: string
    queuedAt: number
}

/** The single writer's queue of subjects whose `owner_followers` is owed a re-count. */
export interface RecountQueueIndex {
    /**
     * Idempotent per DID; queueing a DID again moves its stamp, so a clear of
     * an earlier read leaves it queued. A no-op under `everyone`, where no
     * count is kept and nothing would drain the queue.
     */
    queueRecount(subjects: readonly string[], atMs: number): Promise<void>
    /** Up to `limit` queued DIDs, oldest first. */
    dueRecounts(limit: number): Promise<QueuedRecount[]>
    /** Remove exactly these queueings; a DID queued again since is kept. */
    clearRecounts(entries: readonly QueuedRecount[]): Promise<void>
}

/**
 * One read prefix of the log, reduced to the last op per
 * `(collection, follower, rkey)`. A block's `follower` is its blocker.
 */
export interface CoalescedOps {
    creates: FollowEdge[]
    deletes: EdgeRef[]
    blockCreates: BlockEdge[]
    blockDeletes: BlockRef[]
    /** The largest seq read: what the drop goes through. */
    throughSeq: number
}

/**
 * Keep only the last op per `(collection, follower, rkey)`: a follow and a
 * block can share an rkey and are different rows. Puts and deletes then touch
 * disjoint keys, so they can go in separate batches in either order, and a
 * delete-then-recreate is not reordered.
 */
export function coalesceEdgeOps(ops: readonly EdgeOp[]): CoalescedOps {
    const last = new Map<string, EdgeOp>()
    let throughSeq = 0
    for (const op of ops) {
        last.set(`${op.collection}\u0000${op.follower}\u0000${op.rkey}`, op)
        throughSeq = Math.max(throughSeq, op.seq)
    }
    const creates: FollowEdge[] = []
    const deletes: EdgeRef[] = []
    const blockCreates: BlockEdge[] = []
    const blockDeletes: BlockRef[] = []
    for (const op of last.values()) {
        if (op.collection === "block") {
            if (op.kind === "create") {
                blockCreates.push({ blocker: op.follower, rkey: op.rkey, subject: op.subject })
            } else {
                blockDeletes.push({ blocker: op.follower, rkey: op.rkey })
            }
        } else if (op.kind === "create") {
            creates.push({ follower: op.follower, rkey: op.rkey, subject: op.subject })
        } else {
            deletes.push({ follower: op.follower, rkey: op.rkey })
        }
    }
    return { creates, deletes, blockCreates, blockDeletes, throughSeq }
}

const CREATE_STATEMENTS_PER_CHUNK = 5
const DELETE_STATEMENTS_PER_CHUNK = 3
const BLOCK_STATEMENTS_PER_CHUNK = 1
const RECOUNT_SUBJECTS_PER_STATEMENT = 50

/**
 * Worst-case D1 statements to flush: 5 per 25 follow creates, 3 per 25
 * follow deletes, and 1 per 25 block creates or deletes.
 */
export function flushStatements(
    creates: number,
    deletes: number,
    blockCreates: number,
    blockDeletes: number
): number {
    return (
        CREATE_STATEMENTS_PER_CHUNK * Math.ceil(creates / D1_ROWS_PER_STATEMENT) +
        DELETE_STATEMENTS_PER_CHUNK * Math.ceil(deletes / D1_ROWS_PER_STATEMENT) +
        BLOCK_STATEMENTS_PER_CHUNK *
            (Math.ceil(blockCreates / D1_ROWS_PER_STATEMENT) +
                Math.ceil(blockDeletes / D1_ROWS_PER_STATEMENT))
    )
}

/**
 * How many ops to read so that `remaining` statements cover them whatever
 * their kind split, which is unknown until they are read. Worst case: all
 * but 24 are follow creates and the rest partial chunks of follow deletes,
 * block creates and block deletes.
 */
export function flushLimit(remaining: number): number {
    const partials = DELETE_STATEMENTS_PER_CHUNK + 2 * BLOCK_STATEMENTS_PER_CHUNK
    const chunks = Math.floor((remaining - partials) / CREATE_STATEMENTS_PER_CHUNK)
    return Math.max(0, chunks) * D1_ROWS_PER_STATEMENT
}

export interface EdgeFlushDeps {
    ops: EdgeOpsIndex
    edges: FollowEdgeWriter
    blocks: BlockEdgeWriter
    budget: StatementBudget
    /** A create whose follower or blocker has left interest since it was logged is not written. */
    interest: Pick<InterestIndex, "inInterest">
}

/**
 * Apply one coalesced prefix of logged ops, sized so its worst case fits the
 * budget: creates through `putEdges` at the current generation (skipping
 * followers no longer in interest), deletes through `deleteEdges`; block ops
 * likewise through the block writer. Only after every write commits are the
 * ops dropped and the follow subjects queued for re-count (blocks queue
 * none: they never feed a follower count); a failure leaves the whole prefix
 * to be re-applied. A block is only checked for its blocker still being in
 * interest: the full keep rule is `isBlocked`'s, and the mirror prunes what a
 * DID leaves behind. Returns how many ops were dropped.
 */
export async function flushEdgeOps(deps: EdgeFlushDeps, limit: number): Promise<number> {
    const ops = await deps.ops.edgeOps(limit)
    if (ops.length === 0) return 0
    const { creates, deletes, blockCreates, blockDeletes, throughSeq } = coalesceEdgeOps(ops)
    const inInterest = new Map<string, boolean>()
    const written: FollowEdge[] = []
    // A skipped create still clears any edge its key holds: it may be the
    // re-create that a coalesced delete-then-create left of that key.
    const cleared: EdgeRef[] = [...deletes]
    for (const edge of creates) {
        let keep = inInterest.get(edge.follower)
        if (keep === undefined) {
            keep = await deps.interest.inInterest(edge.follower)
            inInterest.set(edge.follower, keep)
        }
        if (keep) written.push(edge)
        else cleared.push({ follower: edge.follower, rkey: edge.rkey })
    }
    const writtenBlocks: BlockEdge[] = []
    const clearedBlocks: BlockRef[] = [...blockDeletes]
    for (const block of blockCreates) {
        let keep = inInterest.get(block.blocker)
        if (keep === undefined) {
            keep = await deps.interest.inInterest(block.blocker)
            inInterest.set(block.blocker, keep)
        }
        if (keep) writtenBlocks.push(block)
        else clearedBlocks.push({ blocker: block.blocker, rkey: block.rkey })
    }
    const subjects = new Set<string>()
    const gen = writtenBlocks.length > 0 || written.length > 0 ? await deps.ops.currentGen() : 0
    if (writtenBlocks.length > 0) await deps.blocks.putBlocks(writtenBlocks, gen)
    if (clearedBlocks.length > 0) await deps.blocks.deleteBlocks(clearedBlocks)
    if (written.length > 0) {
        for (const s of (await deps.edges.putEdges(written, gen)).subjects) subjects.add(s)
    }
    if (cleared.length > 0) {
        for (const s of (await deps.edges.deleteEdges(cleared)).subjects) subjects.add(s)
    }
    await deps.ops.dropEdgeOps(throughSeq, [...subjects])
    return ops.length
}

export interface OwnerFollowerDeps {
    edges: Pick<FollowEdgeWriter, "followersOf">
    interest: Pick<InterestIndex, "interestPolicy" | "isGraphOwner" | "setOwnerFollowers">
    nowMs(): number
}

/** D1 statements to re-count `subjects` subjects: one `followersOf` per 50. */
export function recountStatements(subjects: number): number {
    return Math.ceil(subjects / RECOUNT_SUBJECTS_PER_STATEMENT)
}

/** How many subjects `remaining` statements can re-count. */
function recountCapacity(remaining: number): number {
    return Math.max(0, remaining) * RECOUNT_SUBJECTS_PER_STATEMENT
}

/**
 * Set each subject's `owner_followers` to the number of distinct followers
 * in the edge index that are graph owners by the single writer's own state
 * (never the mirror's served flag, and not D1's lagging `graph_owners`). A
 * count, not a delta, so re-applying a batch leaves it unchanged; joins and
 * leaves follow from the count. A no-op under `everyone`, where the count
 * does not decide membership.
 */
export async function recountOwnerFollowers(
    deps: OwnerFollowerDeps,
    subjects: readonly string[]
): Promise<void> {
    if (deps.interest.interestPolicy() === "everyone" || subjects.length === 0) return
    const followers = await deps.edges.followersOf(subjects)
    const owner = new Map<string, boolean>()
    for (const subject of new Set(subjects)) {
        let count = 0
        for (const follower of new Set(followers.get(subject) ?? [])) {
            let isOwner = owner.get(follower)
            if (isOwner === undefined) {
                isOwner = await deps.interest.isGraphOwner(follower)
                owner.set(follower, isOwner)
            }
            if (isOwner) count += 1
        }
        await deps.interest.setOwnerFollowers(subject, count, deps.nowMs())
    }
}

/**
 * Re-count up to `limit` queued subjects, as many as the budget covers, and
 * clear them. Returns how many were re-counted.
 */
export async function drainRecounts(
    deps: OwnerFollowerDeps & { queue: RecountQueueIndex; budget: StatementBudget },
    limit: number
): Promise<number> {
    if (deps.interest.interestPolicy() === "everyone") return 0
    const due = await deps.queue.dueRecounts(Math.min(limit, recountCapacity(deps.budget.remaining)))
    if (due.length === 0) return 0
    await recountOwnerFollowers(
        deps,
        due.map((d) => d.did)
    )
    await deps.queue.clearRecounts(due)
    return due.length
}

/** The DIDs the single writer counts as followed by an owner (`owner_followers > 0`), paged by DID. */
export interface OwnerFollowedIndex {
    ownerFollowed(cursor: string | null, limit: number): Promise<{ dids: string[]; cursor: string | null }>
}

/**
 * The daily backstop for a lost decrement: re-count every DID the single
 * writer counts as owner-followed, so a delete, prune or lost ownership
 * whose subjects never reached the queue is corrected. A missed increment
 * from an edge write cannot happen (a put's ops are dropped only with their
 * subjects queued), so D1's subjects are not paged. Resumable through
 * `cursor` (kept in `meta`); returns the next one, or null once the pass is
 * done. Throws when the budget cannot cover a page, so a pass is never
 * recorded done without having run. A no-op under `everyone`.
 */
export async function reconcileOwnerFollowers(
    deps: OwnerFollowerDeps & { followed: OwnerFollowedIndex; budget: StatementBudget },
    cursor: string | null,
    limit: number
): Promise<string | null> {
    if (deps.interest.interestPolicy() === "everyone") return null
    const size = Math.min(limit, recountCapacity(deps.budget.remaining))
    if (size === 0) throw new Error("D1 statement budget exceeded (1 needed)")
    const page = await deps.followed.ownerFollowed(cursor, size)
    await recountOwnerFollowers(deps, page.dids)
    return page.cursor
}
