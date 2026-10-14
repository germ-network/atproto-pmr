/**
 * Secondary records (`MONITOR_COLLECTIONS`, e.g. `app.bsky.actor.profile/self`):
 * snapshots kept beside the declaration for every DID in interest, settled
 * quietly. A secondary never enters the digest window, never pushes, and
 * never moves `revs`; its rev authority is its own `records` row, and a write
 * never replaces a newer one.
 */
import { RecordNotFoundError, type WatchedRecord } from "@germ-network/atproto-pmr-core"
import type { CommitEvent } from "./jetstream"
import { recordFetchedDocument, type FetchedRecord, type VerifyOutcome } from "./ingest"
import {
    compareRev,
    type Cursor,
    type DidDocumentSink,
    type InterestIndex,
    type PendingRecordFetch,
    type RecordRef,
    type SecondaryIndex,
    type SecondaryIntakeIndex,
    type SecondarySnapshotStore,
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

/** Which secondaries a monitor keeps. Commits on any other record are ignored. */
export interface SecondaryConfig {
    records: readonly WatchedRecord[]
}

export type SecondaryIntakeDecision = "ignored" | "duplicate" | "accepted"

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
 * In the follow stream's read loop: owe a fetch for a commit on a watched
 * secondary of a DID in interest, together with the cursor. No I/O beyond
 * the index.
 */
export async function intakeSecondary(
    deps: { index: SecondaryIntakeIndex },
    config: SecondaryConfig,
    event: CommitEvent,
    cursor: Cursor
): Promise<SecondaryIntakeDecision> {
    const watched = config.records.some(
        (r) => r.collection === event.collection && r.rkey === event.rkey
    )
    if (!watched) return "ignored"
    const result = await deps.index.oweSecondary(
        {
            did: event.did,
            collection: event.collection,
            rkey: event.rkey,
            rev: event.rev,
        },
        cursor
    )
    return result.outcome
}

/**
 * Fetch, verify and store one owed secondary, off the read loop. Throws only
 * on a transient failure. Verified: stored at the signed rev unless a newer
 * one is held. Verified absent at a current rev: only that record is
 * disposed. Unverifiable: the previous entry stays.
 *
 * Bytes are written first and the index second, so the index is never ahead
 * of the store. The indexed rev and the DID's interest are read before the
 * put; the index write answers `older` or `left` itself, and only `left` can
 * follow a put (settles run one after another), so only then is the entry
 * just written deleted again.
 */
export async function settleSecondary(
    deps: SecondaryDeps,
    owed: PendingRecordFetch
): Promise<SecondarySettleOutcome> {
    const ref: RecordRef = { did: owed.did, collection: owed.collection, rkey: owed.rkey }
    const left = async (): Promise<SecondarySettleOutcome> => {
        await deps.index.clearSecondary(ref, owed.rev)
        return "left"
    }
    if (!(await stillOwedUnder(deps, ref.did, owed.epoch))) return left()

    let record: FetchedRecord
    try {
        record = await deps.fetchRecord(ref)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        await deps.index.clearSecondary(ref, owed.rev)
        // Without a proof of absence nothing here may be disposed. A gone
        // repo is the declaration's to judge, which also disposes this.
        if (err.reason === "RecordNotFound") return "unverifiable"
        await deps.deferToDeclaration(ref.did)
        return "deferred"
    }
    await recordFetchedDocument(deps, ref.did, record.didDocument)

    const verified = await deps.verify(ref, record)
    if (verified.kind === "unverifiable") {
        await deps.index.clearSecondary(ref, owed.rev)
        return "unverifiable"
    }
    if (!(await stillOwedUnder(deps, ref.did, owed.epoch))) return left()
    const indexed = await deps.index.secondaryRevOf(ref)
    if (indexed !== null && compareRev(indexed, verified.rev) === "regressed") {
        await deps.index.clearSecondary(ref, owed.rev)
        return "older"
    }

    if (verified.kind === "verified-absent") {
        await deps.snapshot.deleteSecondary(ref)
        const answer = await deps.index.disposeSecondary(ref, verified.rev, owed.epoch, owed.rev)
        return answer === "disposed" ? "deleted" : answer
    }

    await deps.snapshot.putSecondary(ref, {
        rev: verified.rev,
        car: record.car,
        observedAtMs: deps.nowMs(),
        source: record.source,
        signingKey: verified.key,
        verifiedWith: verified.key,
        cid: verified.cid,
    })
    const answer = await deps.index.completeSecondary(
        ref,
        verified.rev,
        { cid: verified.cid, verifiedWith: verified.key },
        owed.epoch,
        owed.rev
    )
    if (answer === "left") await deps.snapshot.deleteSecondary(ref)
    return answer
}

async function stillOwedUnder(deps: SecondaryDeps, did: string, epoch: number): Promise<boolean> {
    return (
        (await deps.interest.inInterest(did)) && (await deps.interest.interestEpoch(did)) === epoch
    )
}

/** Drain the owed secondaries, with the declaration path's backoff. */
export async function settleSecondaryDue(
    deps: SecondaryDeps,
    limit = 32,
    backoffMs = (attempts: number) => Math.min(2 ** attempts, 64) * 1000
): Promise<number> {
    const now = deps.nowMs()
    const due = await deps.index.dueSecondaries(now, limit)
    let settled = 0
    for (const owed of due) {
        try {
            if ((await settleSecondary(deps, owed)) === "stored") settled += 1
        } catch {
            await deps.index.deferSecondary(owed, now + backoffMs(owed.attempts))
        }
    }
    return settled
}
