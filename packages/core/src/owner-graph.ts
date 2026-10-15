import type { FollowEdge } from "./follow-edges"

/**
 * The owner's follow graph as the relay reads it to choose a summary's
 * contacts. It crosses only the ingest object's RPC boundary and never
 * reaches a device or any HTTP response: devices consume the summary's
 * computed results, not the graph.
 */

/** One edge from the owner's side, restricted to declaration holders. */
export interface OwnerGraphEdge {
    /** The other party. */
    did: string
    /** The other party also has the reverse edge. */
    mutual: boolean
}

export interface OwnerGraph {
    did: string
    following: OwnerGraphEdge[]
    followers: OwnerGraphEdge[]
}

/**
 * The monitor ingest object's RPC for the owner's graph, following the
 * `MonitorOwnBlocksRequest` pattern: null when the owner's graph is not
 * served, and a D1 failure throws, so neither is ever taken for an empty
 * graph. The monitor does not authenticate; the relay must have
 * authenticated the owner before it asks.
 *
 * Cost: a summary poll makes this call and `ownBlocks`, two RPCs to the
 * singleton ingest object, each one D1 batch.
 */
export interface MonitorOwnGraphRequest {
    ownGraph(did: string): Promise<OwnerGraph | null>
}

/**
 * The owner's graph from the index's edges, which the index has already
 * restricted to declaration holders: an edge is `mutual` iff the reverse edge
 * is also present. Two follow records of one pair make one edge. Edges are
 * sorted by `did`, so equal inputs give equal graphs.
 */
export function ownerGraph(
    did: string,
    following: FollowEdge[],
    followers: FollowEdge[]
): OwnerGraph {
    const followingDids = new Set(following.map((e) => e.subject))
    const followerDids = new Set(followers.map((e) => e.follower))
    const edges = (others: Set<string>, reverse: Set<string>): OwnerGraphEdge[] =>
        [...others]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .map((other) => ({ did: other, mutual: reverse.has(other) }))
    return {
        did,
        following: edges(followingDids, followerDids),
        followers: edges(followerDids, followingDids),
    }
}
