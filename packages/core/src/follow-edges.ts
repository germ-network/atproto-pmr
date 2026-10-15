/**
 * The follow-edge index: who follows whom, for the graphs a monitor serves
 * (its registered users', or every declaration holder's under `everyone`).
 * Edges come from `app.bsky.graph.follow` records and are hints, not proof —
 * a device checks one against the follower's signed record (`follower`/`rkey`)
 * before relying on it.
 */

export const FOLLOW_COLLECTION_NSID = "app.bsky.graph.follow"

/** One `app.bsky.graph.follow` record: `follower` follows `subject`. */
export interface FollowEdge {
    follower: string
    /** The follow record's rkey in the follower's repo. */
    rkey: string
    subject: string
}

/**
 * The read surface of the index. Every follow of a served graph's owner is
 * stored, so an edge is already in place when its subject gains a
 * declaration; reads return only edges whose other party holds a
 * declaration. That filter is the store's, so no caller can serve an edge
 * outside the declaration set. Writing is the ingest's, behind its own seam.
 */
export interface FollowEdgeStore {
    /**
     * Both edge lists of a served graph's owner, restricted to declaration
     * holders, from one consistent read; null when the graph is not served.
     */
    ownEdges(did: string): Promise<{ following: FollowEdge[]; followers: FollowEdge[] } | null>
}
