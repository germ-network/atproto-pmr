import type { ChallengeStore } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"
import type { PMRObject } from "./pmr-object"

/**
 * KV-backed challenge store.
 *
 * Global rather than per-relay, because a challenge is presented before the
 * relay is known.
 *
 * **Best-effort consumption, by contract** (storage consistency item 2).
 * KV has no atomic compare-and-delete, so the read and the delete below are
 * two operations and two concurrent redemptions can both observe the same
 * challenge. That is permitted: the value is a *server challenge* — proof
 * the requester is interacting now, and a bound on replay — not a
 * use-once token. An adapter is explicitly not required to do better.
 *
 * What carries the weight instead is that every challenge-reachable
 * operation is replay-tolerant within the TTL. If you add an operation that
 * is not, this store is not where to fix it.
 *
 * Expiry rides KV's native TTL, which satisfies the observability rule in
 * consistency item 4: a record past `expiresAt` is never returned by a
 * read, because it is gone.
 */
export function kvChallengeStore<TPMR extends PMRObject>(
    env: PMREnv<TPMR>
): ChallengeStore {
    return {
        async mint(challenge, boundTo, expiresAt) {
            // KV's minimum is 60s; a shorter TTL would be silently rejected.
            const ttl = Math.max(
                60,
                Math.floor(expiresAt - Date.now() / 1000)
            )
            await env.challenges.put(challenge, boundTo, { expirationTtl: ttl })
        },

        async consume(challenge) {
            const boundTo = await env.challenges.get(challenge, "text")
            if (boundTo === null) return null
            // Delete after reading, so a challenge is spent regardless of
            // what the caller then decides about it — the same
            // delete-then-verify order germ-service uses, so a redemption
            // attempt cannot be retried into a different verdict.
            await env.challenges.delete(challenge)
            return boundTo
        },
    }
}
