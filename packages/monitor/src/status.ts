/**
 * An operator's read of the monitor's ingest progress: whether the baseline
 * backfill finished, what is still owed, and why one DID is unsettled.
 *
 * Not a monitor surface in the sense of `spec/key-transparency.md`: a
 * deployment must keep it off the monitor's public paths (serve it behind
 * its own authentication, or call it over the Durable Object binding).
 */
import type { BackfillProgress, HolderState, PendingFailure } from "./storage"

/** Lower bounds of the attempt buckets in `PendingSummary.attempts`. */
export const PENDING_ATTEMPT_BUCKETS = [0, 1, 2, 4, 8, 16] as const

/** Aggregate counts only: names no DID. */
export interface PendingSummary {
    count: number
    /** Rows whose `not_before` has passed. */
    due: number
    maxAttempts: number
    /** One entry per `PENDING_ATTEMPT_BUCKETS` bound, in order; a row counts
     * toward the highest bound its attempts reach. */
    attempts: { atLeast: number; count: number }[]
    /** Earliest `owed_at` among rows that have one. */
    oldestOwedAtMs: number | null
    /** Rows owed before `owed_at` was recorded. */
    owedAtUnknown: number
    /** Rows by the kind of their last failure. */
    lastFailure: { threw: number; unverifiable: number; none: number }
}

export interface MonitorIngestStatus {
    asOfMs: number
    backfill: BackfillProgress
    pending: PendingSummary
    /** Owed secondary records (`MONITOR_COLLECTIONS`), one row per record. */
    secondaryPending: PendingSummary
    /** Declarations currently held. */
    heldDeclarations: number
    /** DIDs whose last answer said the repo is gone for good; never re-polled. */
    gonePermanent: number
}

export interface PendingRowDetail {
    rev: string
    attempts: number
    notBeforeMs: number
    quiet: boolean
    owedAtMs: number | null
    lastFailure: PendingFailure | null
}

/**
 * Everything the ingest index knows about one DID. All three null means the
 * monitor has never owed or held it: the backfill or the live tail never
 * reached it.
 */
export interface MonitorPendingDetail {
    did: string
    pending: PendingRowDetail | null
    holderState: HolderState | null
    indexedRev: string | null
}

export interface MonitorIngestStatusRequest {
    ingestStatus(): Promise<MonitorIngestStatus>
    pendingDetail(did: string): Promise<MonitorPendingDetail>
}
