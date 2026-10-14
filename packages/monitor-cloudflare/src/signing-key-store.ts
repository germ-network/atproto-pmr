import type { SigningKeyCacheWriter } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/** A relay signing-key cache entry: the `#atproto` multikey (or null) and when it was learned. */
export interface StoredSigningKey {
    key: string | null
    fetchedAtMs: number
}

/**
 * The relay's per-DID signing-key cache, as `sk:<did>` JSON in `records`.
 * Both the relay's resolver (get/put) and the PLC export consumer
 * (put/delete) go through this, so the two agree on key and shape.
 * Freshness is the reader's job, from `fetchedAtMs`.
 */
export function kvSigningKeyCache<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): SigningKeyCacheWriter & {
    get(did: string): Promise<StoredSigningKey | null>
    put(did: string, entry: StoredSigningKey): Promise<void>
} {
    void env
    throw new Error("not implemented")
}
