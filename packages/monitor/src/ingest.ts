/**
 * Ingest: turning a wake signal into a verified snapshot entry.
 *
 * The shape is two transactions bracketing a fetch, and the ordering is the
 * whole design (`docs/monitor-ingest.md`):
 *
 *   1. intake     — dedupe, record the obligation, advance the cursor
 *   2. (async)    — fetch from the DID's own PDS, verify, write the bytes
 *   3. complete   — index the rev, seal into the window, clear the obligation
 *
 * A failure between 2 and 3 leaves bytes the index does not know: harmless,
 * re-applied when the pending row retries. A failure before 2 leaves the
 * obligation, which retries. What cannot happen is the cursor running ahead
 * of work the store has *lost* — it can only run ahead of work still owed.
 */

import {
    RecordNotFoundError,
    type DidDocument,
    type InterestPolicy,
} from "@germ-network/atproto-pmr-core"
import type { CommitEvent, MonitorEvent } from "./jetstream"
import {
    compareRev,
    FETCH_AS_OF_SKEW_MS,
    type Cursor,
    type DidDocumentSink,
    type InterestIndex,
    type KeyUpdateIndex,
    type MonitorIndex,
    type SnapshotStore,
} from "./storage"

/** The authoritative record, as fetched from the DID's own PDS. */
export interface FetchedRecord {
    car: Uint8Array
    /** The PDS this was fetched from. */
    source: string
    /** The atproto signing key resolved at fetch time; `null` if the DID
     * document carried none. See `resolvePDSEndpoint` in core. */
    signingKey: string | null
    /**
     * The DID document the PDS was resolved from, when the fetch kept it.
     * Absent from a deployment fetch that does not; then nothing is stored.
     */
    didDocument?: FetchedDidDocument
}

/** A DID document as fetched from its directory. */
export interface FetchedDidDocument {
    document: DidDocument
    /** Taken before the directory request, so a write ordered by it can never
     * claim to be newer than what the directory had when asked. */
    fetchedAtMs: number
}

export interface IngestDeps {
    index: MonitorIndex
    snapshot: SnapshotStore
    /**
     * Tier 2: `com.atproto.sync.getRecord` at the DID's own PDS. The only
     * bytes that may enter the snapshot.
     */
    fetchRecord(did: string): Promise<FetchedRecord>
    /**
     * Checks the fetched CAR against the signing key of the DID document
     * fetched with it. Nothing is stored or disposed of without it: the
     * monitor stores nothing fetched, and disposes of nothing on an exclusion
     * proof, without it.
     */
    verify(did: string, record: FetchedRecord): Promise<VerifyOutcome>
    /**
     * How long a DID that has never been held and came back unverifiable
     * stays owed before it is fetched again. Defaults to an hour.
     */
    unverifiableRetryMs?: number
    /** Own-DID push, where a registration holds this DID. */
    onChange?(did: string, rev: string): Promise<void>
    /** Raised when an observed rev moves backwards. Never silent. */
    onRegression?(did: string, indexed: string, observed: string): Promise<void>
    /**
     * Raised when the watched declaration is confirmed unobtainable at
     * the source (`RecordNotFoundError` — see its own doc comment for the
     * two ways this gets confirmed — not merely being unreachable). Fires
     * for a reversible account state too, not only a permanent one: a
     * device deserves to know about a takedown or suspension as much as
     * an outright deletion, even though the monitor itself keeps
     * re-checking a reversible one rather than treating it as settled.
     */
    onDelete?(did: string): Promise<void>
    /**
     * Where a DID document fetched alongside a record is kept. Recorded on
     * every successful fetch, whatever the record's own outcome: the
     * document came from the directory, not from the PDS being judged.
     */
    didDocuments?: DidDocumentSink
    /**
     * Where a relay caches signing keys: an identity/account/sync event for
     * a watched DID also owes a delete of its cached key. A hint only — the
     * PLC export stream is the authority for did:plc.
     */
    keyUpdates?: Pick<KeyUpdateIndex, "oweKeyUpdate">
    /**
     * The allow list. Under `registered`, a declaration commit for a DID
     * outside it is ignored; and a settle whose DID left interest after the
     * fetch began (its epoch moved) stores nothing.
     */
    interest: Pick<InterestIndex, "inInterest" | "interestEpoch">
    /**
     * Disposes every secondary snapshot and index row of a DID. Called when
     * the declaration's fetch finds the repo itself gone, which takes the
     * secondaries with it. Unset where no secondary is kept.
     */
    secondaries?: { dispose(did: string): Promise<void> }
    nowMs(): number
}

const DEFAULT_UNVERIFIABLE_RETRY_MS = 3_600_000

/** Which collection this monitor observes. Everything else is dropped. */
export interface IngestConfig {
    collection: string
    /** Unset behaves as `everyone`: every declaration commit is taken in. */
    policy?: InterestPolicy
}

export type IntakeDecision =
    | "ignored"
    | "duplicate"
    | "accepted"
    /** In the snapshot, and its DID document may have re-keyed. */
    | "reverify"

/**
 * Step 1, in the socket's read loop: cheap, no I/O beyond the index.
 *
 * A slow PDS awaited here would back-pressure the stream, so nothing is
 * fetched on this path — only the obligation is recorded.
 */
export async function intake(
    deps: IngestDeps,
    config: IngestConfig,
    event: MonitorEvent,
    cursor: Cursor
): Promise<IntakeDecision> {
    if (event.kind !== "commit") {
        // Identity/account/sync ignore the collection filter and arrive for
        // every DID. Only those already in the snapshot matter — and for
        // them this is not merely informational: a DID-document rotation
        // changes what the record verifies against, so the record must be
        // read again even though it did not change. `owe` rather than
        // `intake` because the dedupe check would suppress exactly this.
        const known = await deps.index.revOf(event.did)
        if (known === null) return "ignored"
        // A DID confirmed deleted has no live record to re-verify against
        // — re-owing here would only rediscover the same deletion and
        // re-push it, once per identity/account/sync event, forever.
        if (await deps.index.isDeleted(event.did)) return "ignored"
        await deps.index.owe(event.did, known)
        await deps.keyUpdates?.oweKeyUpdate(event.did, { kind: "delete" })
        return "reverify"
    }

    const commit: CommitEvent = event
    if (commit.collection !== config.collection) return "ignored"

    const result = await deps.index.intake(
        { did: commit.did, rev: commit.rev },
        cursor
    )
    return result.outcome === "duplicate" ? "duplicate" : "accepted"
}

/**
 * A terminal outcome for one owed fetch.
 *
 * `rejected` is not an error: the look happened and the answer was an
 * alarm. It is separated from `stored` because the obligation is
 * discharged either way — retrying a regression would hammer the PDS of
 * the very DID under attack, forever, with the same answer. `deleted` is
 * its own case rather than folded into `rejected`: unlike a regression or
 * a failed verification, there is no record left to have an opinion
 * about — the source confirmed it is gone.
 */
export type SettleOutcome =
    | "stored"
    | "rejected"
    | "deleted"
    | "unverifiable"
    /** The DID's interest changed during the fetch: nothing stored, the obligation untouched. */
    | "left"

/**
 * What checking a fetched CAR against the signing key of the DID document
 * fetched with it established. `verified-absent` is a valid proof that the
 * record does not exist at `rev`, not a failure to verify.
 */
export type VerifyOutcome =
    | { kind: "verified"; key: string; rev: string; cid: string }
    | { kind: "verified-absent"; key: string; rev: string }
    | { kind: "unverifiable" }

/**
 * The source confirmed this DID's declaration is gone. Nothing is left to
 * verify or index by rev, so this skips straight to disposing of what's
 * stored. It still reaches the digest window, the same as a stored change
 * would: `completeDeletion` is `complete`'s deletion-shaped counterpart.
 * `permanent` decides only whether this ALSO suppresses future reverify
 * events (see `MonitorIndex.isDeleted`) — a reversible state (an account
 * takedown/suspension that may lift) still disposes of the stale snapshot
 * and still pushes, but must stay open to a later event noticing the
 * reversal.
 */
export async function settleDeletion(
    deps: IngestDeps,
    did: string,
    permanent: boolean,
    quiet = false
): Promise<void> {
    await deps.snapshot.deleteRecord(did)
    await deps.index.completeDeletion(did, deps.nowMs(), permanent, quiet)
    if (!quiet) await deps.onDelete?.(did)
}

/**
 * Steps 2 and 3, off the read loop. Safe to call for a DID owed more than
 * once — the fetch is by DID, not by event, so a burst of revs for one DID
 * collapses into a single authoritative read.
 *
 * Throws only on *transient* failure (the PDS is unreachable), which is
 * what tells the caller to retry with backoff. A `RecordNotFoundError` is
 * NOT transient — it means the fetch succeeded and the PDS authoritatively
 * said the record does not exist — and is handled here rather than
 * re-thrown, specifically so it does not fall into `settleDue`'s retry
 * path: retrying an answer that will not change until something happens
 * again accomplishes nothing but leaving the obligation owed forever.
 */
/** How one settle reports what it finds. */
export interface SettleOptions {
    /**
     * Owed by a join, not a change: an advance is stored through
     * `completeQuietly` with no `onChange`. A not-found for a DID that held a
     * declaration is recorded (gone-reversible, or `deleted` if permanent)
     * with no window entry and no `onDelete`; for a DID that never held one
     * nothing is recorded.
     */
    quiet?: boolean
}

export async function settle(
    deps: IngestDeps,
    did: string,
    opts: SettleOptions = {}
): Promise<SettleOutcome> {
    const quiet = opts.quiet === true
    const epoch = await deps.interest.interestEpoch(did)
    const moved = async () => (await deps.interest.interestEpoch(did)) !== epoch
    let record: FetchedRecord
    try {
        record = await deps.fetchRecord(did)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        if (await moved()) return "left"
        const repoLevel = err.reason !== "RecordNotFound"
        if (quiet && (await neverHeld(deps, did))) {
            // A followee with no declaration is the ordinary case: nothing is
            // recorded for it, so it stays on the non-holder cadence.
            await deps.index.clearPending(did)
            if (repoLevel) await deps.secondaries?.dispose(did)
            return "deleted"
        }
        await settleDeletion(deps, did, err.permanent, quiet)
        if (repoLevel) await deps.secondaries?.dispose(did)
        return "deleted"
    }
    await recordFetchedDocument(deps, did, record.didDocument)

    const outcome = await settleFetched(deps, did, record, quiet, moved)
    // A DID left unwatched has nothing keeping its document current: stop
    // vouching for the one this fetch stored.
    if (!(await deps.index.isWatched(did))) {
        await withdrawFetchedDocument(deps, did, record.didDocument)
    }
    return outcome
}

/** No declaration was ever indexed for `did`, held or gone. */
async function neverHeld(deps: IngestDeps, did: string): Promise<boolean> {
    return (await deps.index.revOf(did)) === null && (await deps.index.holderStateOf(did)) === null
}

async function settleFetched(
    deps: IngestDeps,
    did: string,
    record: FetchedRecord,
    quiet: boolean,
    moved: () => Promise<boolean>
): Promise<SettleOutcome> {
    const verified = await deps.verify(did, record)
    if (await moved()) return "left"
    if (verified.kind === "unverifiable") {
        await settleUnverifiable(deps, did, record)
        return "unverifiable"
    }

    const indexed = await deps.index.revOf(did)
    const movement = compareRev(indexed, verified.rev)
    if (movement === "regressed" && indexed !== null) {
        await deps.onRegression?.(did, indexed, verified.rev)
        await deps.index.clearPending(did)
        return "rejected"
    }

    if (verified.kind === "verified-absent") {
        // The repo is alive and signed to hold no such record. Reversible,
        // because the account may publish it again.
        if (quiet && (await neverHeld(deps, did))) {
            await deps.index.clearPending(did)
            return "deleted"
        }
        await settleDeletion(deps, did, false, quiet)
        return "deleted"
    }

    // A DID-document rotation lands here even when `rev` is unchanged —
    // `intake`'s "reverify" path exists for exactly this case (an identity
    // event, not a repo commit). Compare against what was previously
    // served so a pure key rotation still notifies a registered device,
    // not only a rev movement: a key rotation is arguably the single most
    // security-relevant thing this component exists to catch.
    //
    // Only checked on "unchanged" — an "advanced" movement already fires
    // `onChange` below regardless, so resolving the full previous record
    // (a KV round trip carrying the whole CAR) would be wasted work on
    // every ordinary, non-rotation settle.
    let keyRotated = false
    if (movement === "unchanged") {
        const previous = await deps.snapshot.getRecord(did)
        const previousKey = previous === null ? null : (previous.verifiedWith ?? previous.signingKey)
        keyRotated = previousKey !== null && previousKey !== verified.key
    }

    const observedAtMs = deps.nowMs()
    await deps.snapshot.putRecord(did, {
        rev: verified.rev,
        car: record.car,
        observedAtMs,
        source: record.source,
        signingKey: verified.key,
        verifiedWith: verified.key,
        cid: verified.cid,
    })
    const written = { cid: verified.cid, verifiedWith: verified.key }
    if (quiet) {
        await deps.index.completeQuietly(did, verified.rev, observedAtMs, written)
        return "stored"
    }
    await deps.index.complete(did, verified.rev, observedAtMs, written)

    if (movement === "advanced" || keyRotated) await deps.onChange?.(did, verified.rev)
    return "stored"
}

/**
 * Bytes that do not verify are not evidence of anything the monitor may
 * serve, and the same bytes will fail again, so this is terminal rather
 * than transient. A held DID keeps its entry and is retried by the next
 * refresh interval; a DID never held stays owed (so it stays watched) but
 * waits out that interval.
 */
async function settleUnverifiable(
    deps: IngestDeps,
    did: string,
    record: FetchedRecord
): Promise<void> {
    const held = (await deps.index.revOf(did)) !== null
    if (held) {
        await deps.index.clearPending(did)
        await deps.index.markAttempted(did, deps.nowMs())
    } else {
        await deps.index.deferPending(
            did,
            deps.nowMs() + (deps.unverifiableRetryMs ?? DEFAULT_UNVERIFIABLE_RETRY_MS)
        )
    }
    await pushNewlySeenKey(deps, did, record.signingKey)
}

/**
 * A fetched key that differs from the one the stored entry verified under
 * means a rotation the monitor cannot itself vouch for; the device can
 * verify for itself, so it is told once per newly seen key.
 */
export async function pushNewlySeenKey(
    deps: IngestDeps,
    did: string,
    fetchedKey: string | null
): Promise<void> {
    if (fetchedKey === null) return
    const previous = await deps.snapshot.getRecord(did)
    if (previous === null) return
    const previousKey = previous.verifiedWith ?? previous.signingKey
    if (previousKey === null || fetchedKey === previousKey) return
    if (fetchedKey === previous.seenKey) return
    // KV cannot update metadata alone, so recording the key rewrites the entry.
    await deps.snapshot.putRecord(did, { ...previous, seenKey: fetchedKey })
    await deps.onChange?.(did, previous.rev)
}

/**
 * Keeps the DID document a fetch resolved through, ordered by when that
 * fetch started. A failing sink never costs the caller its fetch: the
 * stored copy is refreshed again by the next one.
 */
export async function recordFetchedDocument(
    deps: Pick<IngestDeps, "didDocuments">,
    did: string,
    fetched: FetchedDidDocument | undefined
): Promise<void> {
    if (fetched === undefined || deps.didDocuments === undefined) return
    try {
        await deps.didDocuments.recordDidDocument(
            did,
            fetched.document,
            fetched.fetchedAtMs - FETCH_AS_OF_SKEW_MS
        )
    } catch {}
}

/**
 * Withdraws trust in the stored document `fetched` just wrote, ordered with
 * that write, for a DID no one will keep current.
 */
async function withdrawFetchedDocument(
    deps: Pick<IngestDeps, "didDocuments">,
    did: string,
    fetched: FetchedDidDocument | undefined
): Promise<void> {
    if (fetched === undefined || deps.didDocuments === undefined) return
    try {
        await deps.didDocuments.markDidDocumentStale(
            did,
            fetched.fetchedAtMs - FETCH_AS_OF_SKEW_MS
        )
    } catch {}
}

/** Drain what is owed. Called by the same clock that watches the socket. */
export async function settleDue(
    deps: IngestDeps,
    limit = 32,
    backoffMs = (attempts: number) => Math.min(2 ** attempts, 64) * 1000
): Promise<number> {
    const now = deps.nowMs()
    const due = await deps.index.duePending(now, limit)
    let settled = 0
    for (const p of due) {
        try {
            if ((await settle(deps, p.did, { quiet: p.quiet })) === "stored") settled += 1
        } catch {
            // A PDS being down is ordinary. The obligation survives; the
            // stream will not redeliver, so the retry queue is the only
            // thing keeping this DID from being silently dropped.
            await deps.index.deferPending(p.did, now + backoffMs(p.attempts))
        }
    }
    return settled
}
