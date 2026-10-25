import { ownerGraph, permissionRecencyAtMs, type FollowEdge } from "@germ-network/atproto-pmr-core"
import type { D1Reader } from "./block-edge-store"
import { kvMessagingKeyFirstSeenMany } from "./snapshot-store"

/**
 * Public ranking hints read directly from the request's D1 session and KV.
 * Either party's served graph can supply the reciprocal held edges; the
 * sender need not be an owner. D1 and KV are best-effort sampled, as in summaries.
 */
export function d1PermissionRecencyReader(
    db: D1Reader,
    env: { records: KVNamespace }
): (sender: string, recipients: readonly string[]) => Promise<Map<string, number | null>> {
    return async (sender, recipients) => {
        const distinct = [...new Set(recipients)]
        const result = new Map<string, number | null>(distinct.map((did) => [did, null]))
        if (distinct.length === 0) return result
        try {
            const statements: D1PreparedStatement[] = []
            for (let i = 0; i < distinct.length; i += 50) {
                const chunk = distinct.slice(i, i + 50)
                const list = chunk.map((_, j) => `?${j + 2}`).join(",")
                // Filter stale rows outside the currently held/served graph,
                // with the same declaration-holder boundary as ownEdges.
                const held = "JOIN graph_holders a ON a.did = f.follower " +
                    "JOIN graph_holders b ON b.did = f.subject "
                const served = "EXISTS (SELECT 1 FROM graph_owners o " +
                    "WHERE o.did = f.follower OR o.did = f.subject)"
                for (const direction of [
                    `f.follower = ?1 AND f.subject IN (${list})`,
                    `f.subject = ?1 AND f.follower IN (${list})`,
                ]) {
                    statements.push(db.prepare(
                        `SELECT f.follower, f.rkey, f.subject FROM follows f ${held}` +
                        `WHERE ${direction} AND ${served}`
                    ).bind(sender, ...chunk))
                }
            }
            const [batches, keyTimes] = await Promise.all([
                db.batch<FollowEdge>(statements),
                kvMessagingKeyFirstSeenMany(env, distinct),
            ])
            const following = batches.filter((_, i) => i % 2 === 0).flatMap((b) => b.results)
            const followers = batches.filter((_, i) => i % 2 === 1).flatMap((b) => b.results)
            // Reuse duplicate/invalid-rkey handling from the held-summary path.
            const graph = ownerGraph(sender, following, followers)
            for (const edge of graph.following) {
                if (!edge.mutual) continue
                result.set(edge.did, permissionRecencyAtMs({
                    messagingKeyFirstSeenAtMs: keyTimes.get(edge.did) ?? null,
                    aFollowedBAtMs: edge.ownerFollowsContactAtMs ?? null,
                    bFollowedAAtMs: edge.contactFollowsOwnerAtMs ?? null,
                }))
            }
        } catch {
            // Recency is optional ranking data; a failed read leaves it unknown.
        }
        return result
    }
}
