/**
 * The current `#atproto` key a public read checks a snapshot's ingest
 * verdict against, so a record signed under a key the DID has since rotated
 * away from is not served. Read paths never reach the network for it: with
 * no trusted current key the check fails closed, except for `did:web`,
 * which no stream covers.
 */

import type { CachedDidDocument, PlcCoverage } from "./did-document"

/**
 * `trusted`: the key the cached DID document carries, while the document is
 * trusted. `unknown`: no trusted document is held, so a `did:plc` read fails
 * closed. `unchecked`: a `did:web` DID, whose snapshots are served on their
 * ingest verdict alone.
 */
export type ReadSigningKey =
    | { kind: "trusted"; key: string }
    | { kind: "unknown" }
    | { kind: "unchecked" }

export interface ReadSigningKeys {
    /**
     * Every DID's key, from as few store reads as the store allows. A
     * `did:plc` document is trusted while the PLC stream has covered it
     * continuously since it was fetched, within the coverage lag bound, or
     * otherwise for `SIGNING_KEY_TTL_MS` after its fetch. A thrown error is a
     * relay fault and propagates.
     */
    keysFor(dids: readonly string[]): Promise<Map<string, ReadSigningKey>>
}

/**
 * Whether a snapshot ingest verified against `verifiedWith` may be served
 * given the DID's current key: only if the key is trusted and the same, or
 * the DID is not checked.
 */
export function servableUnderRotation(_verifiedWith: string, _key: ReadSigningKey): boolean {
    throw new Error("not implemented")
}

/**
 * One DID's {@link ReadSigningKey} from its cached document (null if none is
 * held) and the published stream coverage (null if uncovered), under the
 * trust rule {@link ReadSigningKeys.keysFor} states.
 */
export function readSigningKeyFrom(
    _did: string,
    _cached: CachedDidDocument | null,
    _coverage: PlcCoverage | null,
    _nowMs: number
): ReadSigningKey {
    throw new Error("not implemented")
}
