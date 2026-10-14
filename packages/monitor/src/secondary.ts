/**
 * Secondary records (`MONITOR_COLLECTIONS`, e.g. `app.bsky.actor.profile/self`):
 * snapshots kept beside the declaration for every DID in interest, settled
 * quietly. A secondary never enters the digest window, never pushes, and
 * never moves `revs`; its rev authority is its own `records` row, and a write
 * never replaces a newer one.
 */
import type { FetchedRecord, VerifyOutcome } from "./ingest"
import type {
    DidDocumentSink,
    InterestIndex,
    PendingRecordFetch,
    RecordRef,
    SecondaryIndex,
    SecondarySnapshotStore,
} from "./storage"

export interface SecondaryDeps {
    index: SecondaryIndex
    interest: Pick<InterestIndex, "inInterest" | "interestEpoch">
    snapshot: SecondarySnapshotStore
    /** `com.atproto.sync.getRecord` for `ref` at the DID's own PDS. */
    fetchRecord(ref: RecordRef): Promise<FetchedRecord>
    /** Checks the CAR against the key of the document fetched with it, for `ref`'s path. */
    verify(ref: RecordRef, record: FetchedRecord): Promise<VerifyOutcome>
    /**
     * A repo-level terminal answer (the repo gone, taken down, suspended) is
     * the declaration path's to judge, not a secondary's: owe that instead.
     */
    deferToDeclaration(did: string): Promise<void>
    didDocuments?: DidDocumentSink
    nowMs(): number
}

export type SecondarySettleOutcome =
    | "stored"
    /** A newer rev is indexed: nothing was written. */
    | "older"
    /** The DID left interest while this was in flight: nothing is kept. */
    | "left"
    | "deleted"
    | "unverifiable"
    /** Handed to the declaration path on a repo-level terminal answer. */
    | "deferred"

/**
 * Fetch, verify and store one owed secondary, off the read loop. Throws only
 * on a transient failure. Verified: stored at the signed rev unless a newer
 * one is held. Verified absent at a current rev: only that record is
 * disposed. Unverifiable: the previous entry stays.
 */
export async function settleSecondary(
    _deps: SecondaryDeps,
    _owed: PendingRecordFetch
): Promise<SecondarySettleOutcome> {
    throw new Error("not implemented")
}

/** Drain the owed secondaries, with the declaration path's backoff. */
export async function settleSecondaryDue(
    _deps: SecondaryDeps,
    _limit = 32,
    _backoffMs = (attempts: number) => Math.min(2 ** attempts, 64) * 1000
): Promise<number> {
    throw new Error("not implemented")
}
