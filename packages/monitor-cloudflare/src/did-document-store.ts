import type {
    CachedDidDocument,
    DidDocument,
    DidDocumentCache,
    PlcCoverage,
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
    void document
    throw new Error("not implemented")
}

/**
 * The relay's read: `storedSigningKeyResolver`'s `documents`. A malformed
 * entry reads as none. A DID that leaves the watched set (settle
 * rejected it before it was ever indexed) keeps its last entry until it ages
 * past trust, so a direct reader must apply the same trust rule.
 */
export function kvDidDocuments<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): DidDocumentCache {
    void env
    throw new Error("not implemented")
}

/** No expirationTtl: the reader enforces age from `confirmedAtMs`. */
export function kvDidDocumentWriter<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): {
    put(did: string, cached: CachedDidDocument): Promise<void>
    delete(did: string): Promise<void>
} {
    void env
    throw new Error("not implemented")
}

/** The relay's read: `storedSigningKeyResolver`'s `getPlcCoverage`. A malformed entry reads as none. */
export function kvPlcCoverage<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): () => Promise<PlcCoverage | null> {
    void env
    throw new Error("not implemented")
}
