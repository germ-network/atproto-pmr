import type { SnapshotEntry, SnapshotStore } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"

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
}

export function kvSnapshotStore(env: MonitorEnv): SnapshotStore {
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
            }
        },

        async putRecord(did: string, entry: SnapshotEntry): Promise<void> {
            // No expirationTtl, deliberately: an unchanged record must stay
            // served indefinitely.
            await env.records.put(RECORD_PREFIX + did, entry.car, {
                metadata: {
                    rev: entry.rev,
                    observedAtMs: entry.observedAtMs,
                } satisfies StoredMeta,
            })
        },

        async getSealedWindow(windowId: string): Promise<Uint8Array | null> {
            const v = await env.records.get(WINDOW_PREFIX + windowId, "arrayBuffer")
            return v === null ? null : new Uint8Array(v)
        },

        async putSealedWindow(windowId: string, filter: Uint8Array): Promise<void> {
            // Windows DO expire: past the published retention a client
            // falls back to direct re-verification, which is the cost it
            // would pay without a digest at all.
            await env.records.put(WINDOW_PREFIX + windowId, filter)
        },
    }
}
