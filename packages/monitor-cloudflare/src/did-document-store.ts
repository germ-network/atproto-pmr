import type {
    CachedDidDocument,
    DidDocument,
    DidDocumentCache,
    PlcCoverage,
    PlcLogStore,
    ReadSigningKeys,
} from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/**
 * The stored DID documents on KV, where a relay reads them — never the
 * ingest object (see `kvSnapshotStore`). `MonitorIngest` is the only writer,
 * and publishes here from its own ordered copy.
 */

/**
 * `doc:<did>` = {@link CachedDidDocument} JSON, `fetchedAtMs` being when the
 * monitor last confirmed it current. Absent for a DID the monitor cannot
 * vouch for (tombstoned, or changed in a way it could not render).
 */
export const DID_DOCUMENT_PREFIX = "doc:"

/** Singleton: {@link PlcCoverage} JSON. */
export const PLC_COVERAGE_KEY = "plc:coverage"

/**
 * The stored form, and the equality the store uses: keys sorted recursively,
 * no whitespace, `"null"` for a gone identity. A render and a fetch of the
 * same state compare equal however their keys were ordered.
 */
export function canonicalDidDocumentJson(document: DidDocument | null): string {
    return JSON.stringify(sortKeys(document))
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, v]) => [key, sortKeys(v)])
    )
}

/**
 * The relay's read: `storedSigningKeyResolver`'s `documents`. A malformed
 * entry reads as none. A DID that leaves the monitor's watched set is
 * given no more updates, so an entry for it ages out: a direct reader must
 * apply the same trust rule.
 */
export function kvDidDocuments<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): DidDocumentCache {
    return {
        async get(did) {
            const text = await env.records.get(DID_DOCUMENT_PREFIX + did)
            return text === null ? null : parseCached(text)
        },
    }
}

function parseCached(text: string): CachedDidDocument | null {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return null
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const { doc, fetchedAtMs, source } = value as Record<string, unknown>
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null
    if (typeof (doc as { id?: unknown }).id !== "string") return null
    if (typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs)) return null
    if (source !== "plc" && source !== "web") return null
    return value as CachedDidDocument
}

/**
 * The read paths' rotation-check keys: `doc:` entries in bulk reads of up to
 * a hundred, `plc:coverage` once per call, mapped by `readSigningKeyFrom`.
 * Never reaches the network.
 */
export function kvReadSigningKeys<TIngest extends MonitorIngest = MonitorIngest>(
    _env: MonitorEnv<TIngest>,
    _nowMs: () => number = Date.now
): ReadSigningKeys {
    return {
        async keysFor() {
            throw new Error("not implemented")
        },
    }
}

/**
 * The DID-document route's logs: `plclog:<did>` in the `records` namespace,
 * published by the ingest object for kept did:plc DIDs. A malformed entry
 * reads as none.
 */
export function kvPlcLogs<TIngest extends MonitorIngest = MonitorIngest>(
    _env: MonitorEnv<TIngest>
): PlcLogStore {
    return {
        async get() {
            throw new Error("not implemented")
        },
    }
}

/** No expirationTtl: the reader enforces age from `fetchedAtMs`. */
export function kvDidDocumentWriter<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): {
    put(did: string, cached: CachedDidDocument): Promise<void>
    delete(did: string): Promise<void>
} {
    return {
        put: (did, cached) => env.records.put(DID_DOCUMENT_PREFIX + did, JSON.stringify(cached)),
        delete: (did) => env.records.delete(DID_DOCUMENT_PREFIX + did),
    }
}

/** The relay's read: `storedSigningKeyResolver`'s `getPlcCoverage`. A malformed entry reads as none. */
export function kvPlcCoverage<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): () => Promise<PlcCoverage | null> {
    return async () => {
        const text = await env.records.get(PLC_COVERAGE_KEY)
        if (text === null) return null
        let value: unknown
        try {
            value = JSON.parse(text)
        } catch {
            return null
        }
        if (typeof value !== "object" || value === null) return null
        const { url, continuousSinceMs, coveredThroughMs } = value as Record<string, unknown>
        if (typeof url !== "string") return null
        if (typeof continuousSinceMs !== "number" || !Number.isFinite(continuousSinceMs)) return null
        if (typeof coveredThroughMs !== "number" || !Number.isFinite(coveredThroughMs)) return null
        return { url, continuousSinceMs, coveredThroughMs }
    }
}
