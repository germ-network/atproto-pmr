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
    /** Private ordering hint from the owner's follow record rkey. */
    ownerFollowsContactAtMs?: number | null
    /** Private ordering hint from the contact's follow record rkey. */
    contactFollowsOwnerAtMs?: number | null
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
    const timestamps = (rows: FollowEdge[], otherOf: (e: FollowEdge) => string) => {
        const out = new Map<string, number | null>()
        for (const edge of rows) {
            const did = otherOf(edge)
            const atMs = followRkeyAtMs(edge.rkey)
            const prior = out.get(did)
            if (prior === undefined) {
                out.set(did, atMs)
            } else if (prior === null || atMs === null) {
                out.set(did, null)
            } else {
                out.set(did, Math.max(prior, atMs))
            }
        }
        return out
    }
    const followingAt = timestamps(following, (e) => e.subject)
    const followersAt = timestamps(followers, (e) => e.follower)
    const edges = (
        others: Set<string>,
        reverse: Set<string>,
        ownTimes: Map<string, number | null>,
        reverseTimes: Map<string, number | null>
    ): OwnerGraphEdge[] =>
        [...others]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .map((other) => ({
                did: other,
                mutual: reverse.has(other),
                ownerFollowsContactAtMs: ownTimes.get(other) ?? null,
                contactFollowsOwnerAtMs: reverseTimes.get(other) ?? null,
            }))
    return {
        did,
        following: edges(followingDids, followerDids, followingAt, followersAt),
        followers: edges(followerDids, followingDids, followingAt, followersAt),
    }
}

/** AT Protocol TID timestamp: 53-bit Unix microseconds followed by 10 clock-ID bits. */
export function followRkeyAtMs(rkey: string): number | null {
    if (!/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(rkey)) return null
    let value = 0n
    for (const char of rkey) {
        const digit = "234567abcdefghijklmnopqrstuvwxyz".indexOf(char)
        if (digit < 0) return null
        value = (value << 5n) | BigInt(digit)
    }
    const milliseconds = Number((value >> 10n) / 1000n)
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null
}
