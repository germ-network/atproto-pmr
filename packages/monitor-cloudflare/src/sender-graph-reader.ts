import { d1BlockEdgeStore, type D1Reader } from "./block-edge-store"
import type { PairFact, RecipientGraphFacts, SenderGraphReader } from "@germ-network/atproto-pmr-core"

/**
 * The graph facts for one sender against many recipients over the D1
 * `graph` database or a session over it, in a fixed number of queries
 * whatever the recipient count: follows and blocks naming the sender, and which recipients' graphs
 * are served. Only a served graph's edges are complete; a non-owner's kept
 * edges arrive with its next listing, so for a recipient not served a
 * missing row proves nothing and the fact is `unknown`. A follow row is a
 * hint like every kept edge and is read as held. Blocks are read
 * through the block index's `blockersOf`, so its keep rule decides.
 */
export function d1SenderGraphReader(db: D1Reader): SenderGraphReader {
    const blocks = d1BlockEdgeStore(db)
    return {
        async forSender(sender, recipients) {
            const facts = new Map<string, RecipientGraphFacts>()
            const distinct = [...new Set(recipients)]
            for (let i = 0; i < distinct.length; i += CHUNK) {
                const chunk = distinct.slice(i, i + CHUNK)
                const list = placeholders(chunk.length, 2)
                const [following, served, blockers] = await Promise.all([
                    db
                        .prepare(`SELECT DISTINCT follower FROM follows WHERE subject = ?1 AND follower IN (${list})`)
                        .bind(sender, ...chunk)
                        .all<{ follower: string }>(),
                    db
                        .prepare(`SELECT did FROM graph_owners WHERE did IN (${placeholders(chunk.length, 1)})`)
                        .bind(...chunk)
                        .all<{ did: string }>(),
                    blocks.blockersOf(sender, chunk),
                ])
                const follows = new Set(following.results.map((r) => r.follower))
                const owners = new Set(served.results.map((r) => r.did))
                for (const recipient of chunk) {
                    const complete = owners.has(recipient)
                    const fact = (hit: boolean): PairFact => (hit ? "yes" : complete ? "no" : "unknown")
                    facts.set(recipient, {
                        blocks: fact(blockers.has(recipient)),
                        follows: fact(follows.has(recipient)),
                    })
                }
            }
            return facts
        },
    }
}

/** Recipients per query, the IN-list size the follow index already uses. */
const CHUNK = 50

const placeholders = (count: number, from: number): string =>
    Array.from({ length: count }, (_, i) => `?${from + i}`).join(",")
