import {
    SIGNING_KEY_MAX_STALE_MS,
    type CachedSigningKey,
    type SigningKeyCache,
} from "@germ-network/atproto-pmr-core"
import type { SigningKeyCacheWriter } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

const KEY_PREFIX = "sk:"

/**
 * The relay's per-DID signing-key cache, as `sk:<did>` JSON in `records`.
 * Both the relay's resolver (get/put) and the PLC export consumer
 * (put/delete) go through this, so the two agree on key and shape.
 * Freshness is the reader's job, from `fetchedAtMs`; the KV expiry is only
 * the stale-if-error horizon, so an abandoned entry ages out and a read
 * never outlives it.
 */
export function kvSigningKeyCache<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): SigningKeyCache & SigningKeyCacheWriter {
    return {
        async get(did) {
            const raw = await env.records.get(KEY_PREFIX + did)
            if (raw === null) return null
            try {
                const v: unknown = JSON.parse(raw)
                if (typeof v !== "object" || v === null) return null
                const { key, fetchedAtMs } = v as Record<string, unknown>
                if (typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs)) return null
                if (key !== null && typeof key !== "string") return null
                return { key, fetchedAtMs }
            } catch {
                return null
            }
        },
        async put(did, entry) {
            await env.records.put(KEY_PREFIX + did, JSON.stringify(entry), {
                expirationTtl: Math.ceil(SIGNING_KEY_MAX_STALE_MS / 1000),
            })
        },
        async delete(did) {
            await env.records.delete(KEY_PREFIX + did)
        },
    }
}
