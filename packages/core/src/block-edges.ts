/**
 * The block index: `app.bsky.graph.block` records of the DIDs a monitor
 * keeps them for — every block of a served graph's owner, and a non-owner
 * in interest's blocks of registered DIDs. Unlike follows, block lists are
 * not projected or served publicly, since no device reads another DID's and
 * serving them would cost: an owner reads their own through the
 * authenticated summary, and other DIDs' blocks only answer whether one DID
 * blocks another. Rows are hints, not proof — a device checks one against the
 * blocker's signed record before relying on it.
 */

export const BLOCK_COLLECTION_NSID = "app.bsky.graph.block"

/** One `app.bsky.graph.block` record: `blocker` blocks `subject`. */
export interface BlockEdge {
    blocker: string
    /** The block record's rkey in the blocker's repo. */
    rkey: string
    subject: string
}

/**
 * The read surface of the block index. There is deliberately no listing of
 * another DID's blocks: `ownBlocks` is for the owner's own authenticated
 * read, `isBlocked` answers one pair, and `blockersOf` answers many pairs
 * that share a subject.
 */
export interface BlockEdgeStore {
    /**
     * `did`'s blocks, by rkey; null when `did`'s graph is not served, so a
     * reader never takes "not served" for "blocks nobody".
     */
    ownBlocks(did: string): Promise<BlockEdge[] | null>
    /** Whether a kept block by `blocker` names `subject`. */
    isBlocked(blocker: string, subject: string): Promise<boolean>
    /**
     * Which of `blockers` have a kept block naming `subject`: exactly those
     * for which `isBlocked(blocker, subject)` is true. The caller bounds
     * `blockers` to one IN-list (at most 50).
     */
    blockersOf(subject: string, blockers: readonly string[]): Promise<Set<string>>
}

/**
 * The monitor ingest object's RPC for the owner's own blocks, reached across
 * Workers by the relay's summary read.
 *
 * This is the pattern for any owner-scoped read the monitor holds: one
 * request interface here; one ingest-object method implementing it, which
 * reads D1 directly and lets a failure throw; and one relay adapter that
 * forwards over the `MONITOR_INGEST` binding and throws on a missing binding
 * or any failure, so a failed read is never mistaken for an empty list. A
 * DID whose graph is not served answers null.
 *
 * The monitor does not authenticate: it answers any DID for any holder of the
 * binding. The relay must have authenticated the owner before it asks.
 */
export interface MonitorOwnBlocksRequest {
    ownBlocks(did: string): Promise<BlockEdge[] | null>
}
