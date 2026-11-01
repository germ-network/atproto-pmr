import { didWebDocumentURL, type StoredPolicies } from "@germ-network/atproto-pmr-core"
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

const impliedDocumentUrl = (did: string): string => new URL(didWebDocumentURL(did)).href

/** The metadata form of `evidence`; throws for a did:web authority the DID does not imply. */
export function slimEvidence(evidence: SnapshotEvidence): StoredEvidenceMeta {
    const { authority } = evidence
    let stored: StoredAuthority
    if (authority.method === "plc") {
        stored = authority
    } else {
        const relativeMethodId = authority.verificationMethodId === "#atproto"
        if (
            authority.documentUrl !== impliedDocumentUrl(evidence.did) ||
            (!relativeMethodId && authority.verificationMethodId !== `${evidence.did}#atproto`)
        ) {
            throw new Error(`did:web authority for ${evidence.did} is not derivable from the DID`)
        }
        stored = { method: "web", keyFingerprint: authority.keyFingerprint, relativeMethodId }
    }
    return {
        authority: stored,
        assurance: evidence.assurance,
        monitor: evidence.monitor,
        commitFirstObservedAtMs: evidence.commitFirstObservedAtMs,
        anchorFirstObservedAtMs: evidence.anchorFirstObservedAtMs,
    }
}

/** The full evidence for the record at `ref` that `meta` was stored for; `null` when it carries none. */
export function storedEvidence(
    ref: { did: string; collection: string; rkey: string },
    meta: SnapshotIndexMeta
): SnapshotEvidence | null {
    const stored = meta.evidence
    if (!stored) return null
    const { cid, commitCid, rev, verifiedWith } = meta
    if (cid == null || commitCid == null || verifiedWith == null) return null
    const { authority } = stored
    const fullAuthority: SnapshotEvidence["authority"] =
        authority.method === "plc"
            ? authority
            : {
                  method: "web",
                  documentUrl: impliedDocumentUrl(ref.did),
                  verificationMethodId: authority.relativeMethodId ? "#atproto" : `${ref.did}#atproto`,
                  keyFingerprint: authority.keyFingerprint,
              }
    return {
        did: ref.did,
        collection: ref.collection,
        rkey: ref.rkey,
        recordCid: cid,
        commitCid,
        rev,
        verifiedWith,
        ...stored,
        authority: fullAuthority,
    }
}

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

const LENGTH_BYTES = 4

/** The value of a v2 entry: a 4-byte big-endian detail length, the detail JSON, then the CAR. */
export function encodeSnapshotValue(detail: SnapshotDetail, car: Uint8Array): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify({ source: detail.source, signingKey: detail.signingKey }))
    const out = new Uint8Array(LENGTH_BYTES + json.byteLength + car.byteLength)
    new DataView(out.buffer).setUint32(0, json.byteLength)
    out.set(json, LENGTH_BYTES)
    out.set(car, LENGTH_BYTES + json.byteLength)
    return out
}

/** `null` for bytes that are not a well-formed envelope. */
export function decodeSnapshotValue(value: Uint8Array): { detail: SnapshotDetail; car: Uint8Array } | null {
    if (value.byteLength < LENGTH_BYTES) return null
    const length = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0)
    if (length > value.byteLength - LENGTH_BYTES) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(new TextDecoder().decode(value.subarray(LENGTH_BYTES, LENGTH_BYTES + length)))
    } catch {
        return null
    }
    if (typeof parsed !== "object" || parsed === null) return null
    const { source, signingKey } = parsed as Record<string, unknown>
    if (typeof source !== "string" || !(typeof signingKey === "string" || signingKey === null)) return null
    return { detail: { source, signingKey }, car: value.slice(LENGTH_BYTES + length) }
}

const isString = (v: unknown): v is string => typeof v === "string"
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string"

/** `null` for metadata of any version other than {@link SNAPSHOT_FORMAT_VERSION}. */
export function readIndexMeta(metadata: unknown): SnapshotIndexMeta | null {
    if (typeof metadata !== "object" || metadata === null) return null
    const m = metadata as Record<string, unknown>
    if (m.v !== SNAPSHOT_FORMAT_VERSION) return null
    if (!isString(m.rev) || !Number.isSafeInteger(m.observedAtMs)) return null
    if (!isNullableString(m.cid) || !isNullableString(m.commitCid) || !isNullableString(m.verifiedWith)) return null
    return metadata as SnapshotIndexMeta
}
