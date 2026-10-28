import type { StoredPolicies } from "@germ-network/atproto-pmr-core"
import type { SnapshotEvidence } from "@germ-network/atproto-pmr-monitor"

/**
 * The layout of one `rec:` KV entry. The metadata is the bounded index the
 * bulk readers need; the value is an envelope of per-record detail and the
 * CAR, written in the same put. The ingest object writes these and never
 * reads them back.
 */

/** Bumped on any change to the entry layout; readers serve only this version. */
export const SNAPSHOT_FORMAT_VERSION = 2

/** Cloudflare KV's cap on one key's metadata, as UTF-8 bytes of its JSON. */
export const KV_METADATA_MAX_BYTES = 1024

/**
 * Every field here has a bounded length, so the metadata fits the cap by
 * construction; `writeEntry` throws rather than store more.
 */
export interface SnapshotIndexMeta {
    v: typeof SNAPSHOT_FORMAT_VERSION
    rev: string
    cid: string | null
    commitCid: string | null
    verifiedWith: string | null
    observedAtMs: number
    /** Declarations only. */
    policies?: StoredPolicies
    messagingKeyFirstSeenAtMs?: number | null
    evidence?: StoredEvidenceMeta | null
}

/**
 * The part of a {@link SnapshotEvidence} the metadata and the DID do not
 * already imply; read back as the full object.
 */
export interface StoredEvidenceMeta {
    authority: StoredAuthority
    assurance: SnapshotEvidence["assurance"]
    monitor: string
    commitFirstObservedAtMs: number
    anchorFirstObservedAtMs: number
}

/**
 * A did:web authority without its document URL, which the DID determines.
 * `relativeMethodId` records whether the verification method id was the
 * bare `#atproto` rather than `<did>#atproto`.
 */
export type StoredAuthority =
    | Extract<SnapshotEvidence["authority"], { method: "plc" }>
    | { method: "web"; keyFingerprint: string; relativeMethodId: boolean }

/** Public per-record detail with no length bound, kept in the value. */
export interface SnapshotDetail {
    /** The PDS the CAR was fetched from. */
    source: string
    /** The atproto signing key resolved at fetch time. */
    signingKey: string | null
}

/** Thrown when an entry's metadata would exceed the KV cap: a layout bug, never trimmed around. */
export class SnapshotMetadataTooLarge extends Error {
    constructor(
        readonly key: string,
        readonly bytes: number
    ) {
        super(`snapshot metadata for ${key} is ${bytes} B, over the ${KV_METADATA_MAX_BYTES} B KV cap`)
        this.name = "SnapshotMetadataTooLarge"
    }
}

export function snapshotIndexMetaBytes(meta: SnapshotIndexMeta): number {
    return new TextEncoder().encode(JSON.stringify(meta)).byteLength
}

/** The value of a v2 entry: a 4-byte big-endian detail length, the detail JSON, then the CAR. */
export function encodeSnapshotValue(detail: SnapshotDetail, car: Uint8Array): Uint8Array {
    void detail
    void car
    throw new Error("not implemented")
}

/** `null` for bytes that are not a well-formed envelope. */
export function decodeSnapshotValue(value: Uint8Array): { detail: SnapshotDetail; car: Uint8Array } | null {
    void value
    throw new Error("not implemented")
}

/** `null` for metadata of any version other than {@link SNAPSHOT_FORMAT_VERSION}. */
export function readIndexMeta(metadata: unknown): SnapshotIndexMeta | null {
    void metadata
    throw new Error("not implemented")
}
