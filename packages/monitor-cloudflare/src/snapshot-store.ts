import type { SnapshotEntry, SnapshotStore } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/**
 * The serving half of the seam, on KV.
 *
 * KV rather than Durable Object storage because the read paths are public,
 * cacheable, and want to run in plain Workers near the caller — the
 * community view should scale like the public data it is, not funnel
 * through one object in one location. Eventual consistency is acceptable
 * here and only here: a stale read is `rev` skew, which the trust model
 * already treats as ordinary. `rev` *comparisons* read the index instead.
 */

const RECORD_PREFIX = "rec:"
const WINDOW_PREFIX = "win:"

/** Stored beside the bytes so a reader knows what it holds without the index. */
interface StoredMeta {
    rev: string
    observedAtMs: number
    source: string
    signingKey: string | null
}

/**
 * Generic over the Durable Object class for the same reason `PMREnv` is: a
 * deployment subclasses `MonitorIngest` to supply the authoritative fetch,
 * and `protected fetchRecord` makes the subclass non-assignable to the
 * base. Without the parameter every adopter who followed that advice would
 * hit a type error here.
 */
export function kvSnapshotStore<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): SnapshotStore {
    return {
        async getRecord(did: string): Promise<SnapshotEntry | null> {
            const { value, metadata } = await env.records.getWithMetadata<StoredMeta>(
                RECORD_PREFIX + did,
                "arrayBuffer"
            )
            if (value === null || metadata === null) return null
            return {
                rev: metadata.rev,
                car: new Uint8Array(value),
                observedAtMs: metadata.observedAtMs,
                // Older entries, written before provenance existed, carry no
                // `source`/`signingKey` in their KV metadata. `""`/`null`
                // read the same as "unknown" everywhere this is compared —
                // never a false match — so a mixed store degrades safely
                // rather than needing a backfill before Phase 1 can ship.
                source: metadata.source ?? "",
                signingKey: metadata.signingKey ?? null,
            }
        },

        async putRecord(did: string, entry: SnapshotEntry): Promise<void> {
            // No expirationTtl, deliberately: an unchanged record must stay
            // served indefinitely.
            await env.records.put(RECORD_PREFIX + did, entry.car, {
                metadata: {
                    rev: entry.rev,
                    observedAtMs: entry.observedAtMs,
                    source: entry.source,
                    signingKey: entry.signingKey,
                } satisfies StoredMeta,
            })
        },

        async getSealedWindow(windowId: string): Promise<Uint8Array | null> {
            const v = await env.records.get(WINDOW_PREFIX + windowId, "arrayBuffer")
            return v === null ? null : new Uint8Array(v)
        },

        async putSealedWindow(windowId: string, filter: Uint8Array): Promise<void> {
            // Windows DO expire, unlike records: past the published
            // retention a client falls back to direct re-verification,
            // which is the cost it would pay with no digest at all. The
            // comment used to say this while the code kept them forever.
            const ttl = Number.parseInt(env.WINDOW_RETENTION_SECONDS, 10)
            await env.records.put(WINDOW_PREFIX + windowId, filter, {
                expirationTtl: Number.isFinite(ttl) ? Math.max(60, ttl) : undefined,
            })
        },
    }
}
