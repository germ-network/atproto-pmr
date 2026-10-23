/** Evidence strength is explicit; a current-key seed is not a custody proof. */
export type EvidenceAssurance = "custody-chain" | "current-key-cross-check"

/** Method-specific identity for the key that verified a repository commit. */
export type EvidenceAuthorityIdentity =
    | { method: "plc"; operationCid: string }
    | {
          method: "web"
          documentUrl: string
          verificationMethodId: string
          keyFingerprint: string
      }

/** Exact accepted declaration observation. */
export interface DeclarationEvidenceIdentity {
    did: string
    collection: string
    rkey: string
    recordCid: string
    commitCid: string
    rev: string
    verifiedWith: string
    authority: EvidenceAuthorityIdentity
}

/** Persisted monitor-local anchors paired atomically with the held CAR. */
export interface SnapshotEvidence extends DeclarationEvidenceIdentity {
    assurance: EvidenceAssurance
    monitor: string
    commitFirstObservedAtMs: number
    anchorFirstObservedAtMs: number
}

/** The compact summary view; time values are durations, never wall-clock timestamps. */
export interface SummaryEvidence {
    commitCid: string
    rev: string
    authority: EvidenceAuthorityIdentity
    assurance: EvidenceAssurance
    monitor: string
    commitAgeMs: number | null
    anchorAgeMs: number | null
    remainingTtlMs: number | null
}
