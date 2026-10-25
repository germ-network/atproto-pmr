/**
 * Ingest: turning a wake signal into a verified snapshot entry.
 *
 * The shape is two transactions bracketing a fetch, and the ordering is the
 * whole design (`spec/key-transparency.md`, "Keeping the snapshot current"):
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
    DECLARATION_COLLECTION_NSID,
    declarationAnchorKeyOf,
    readRecordFromCar,
    type DidDocument,
    type InterestPolicy,
} from "@germ-network/atproto-pmr-core"
import { sha256 } from "@noble/hashes/sha2.js"
import { streamTimeUs } from "./firehose-coverage"
import type { CommitEvent, MonitorEvent } from "./jetstream"
import {
    compareRev,
    FETCH_AS_OF_SKEW_MS,
    type Cursor,
    type DidDocumentSink,
    type GoneCause,
    type EvidenceAssurance,
    type EvidenceAuthorityIdentity,
    type InterestIndex,
    type KeyUpdateIndex,
    type MonitorIndex,
    type PendingFailure,
    type SnapshotEntry,
    type SnapshotEvidence,
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
    /**
     * Start of the bounded DID-document/PDS read attempt, which declaration
     * evidence is bounded by. A fetch that omits it may have one stamped
     * around the call by its caller (monitor-cloudflare does); with none,
     * the declaration is stored without evidence.
     */
    attemptStartedAtMs?: number
}

/** The declaration a settle just stored, as verified. */
export interface SettledDeclaration {
    rev: string
    cid: string
    /** The record's CAR, exactly as stored. */
    car: Uint8Array
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
    /**
     * Raised once for every deferral that counts an attempt: a settle that
     * threw, or a never-held DID that came back unverifiable. Not raised for
     * a confirmed deletion, a verified absence, a regression, or a DID that
     * left interest mid-fetch. Called synchronously; a throw is swallowed.
     */
    onSettleFailure?(event: SettleFailureEvent): void
    /**
     * The longest a failed fetch for `did` waits before its next attempt. A
     * pending row takes the DID out of the refresh schedule, so a DID that
     * schedule covers should answer its own refresh interval, keeping it no
     * staler than refresh would. Defaults to `SETTLE_RETRY_CAP_MS`.
     */
    retryCapMs?(did: string): Promise<number>
    /** Own-DID push, where a registration holds this DID. */
    onChange?(did: string, rev: string): Promise<void>
    /**
     * Every verified declaration stored (settle, quiet or not, and quiet
     * refresh) and every one disposed of (deletion, interest leave), after
     * the index write that discharges it. A snapshot-store read may still see
     * the previous value; this argument is authoritative. `null` for a
     * disposal. Raised before `onChange`; a throw is swallowed.
     */
    onSettled?(did: string, settled: SettledDeclaration | null): Promise<void>
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

/** A permanently failing DID is retried about once a month, no more. */
export const SETTLE_RETRY_CAP_MS = 30 * 24 * 3_600_000

/** Longest error message kept on a pending row or logged with it. */
export const PENDING_FAILURE_MESSAGE_MAX = 256

/** 2^attempts seconds, capped at `capMs`. Finite for any attempts. */
export function settleRetryBackoffMs(
    attempts: number,
    capMs: number = SETTLE_RETRY_CAP_MS
): number {
    return Math.min(2 ** Math.min(attempts, 40) * 1000, capMs)
}

/** `text` cut to `PENDING_FAILURE_MESSAGE_MAX`, as kept on a pending row. */
export function truncated(text: string): string {
    return text.length > PENDING_FAILURE_MESSAGE_MAX ? text.slice(0, PENDING_FAILURE_MESSAGE_MAX) : text
}

/**
 * Defers `did` and tells `onSettleFailure` once, with exactly what was stored.
 * A row that is already gone counts nothing, so reports nothing. A failing
 * hook never costs the caller its deferral or the rest of the drain.
 */
async function deferFailure(
    deps: IngestDeps,
    did: string,
    notBeforeMs: number,
    failure: PendingFailure
): Promise<void> {
    const kept: PendingFailure =
        failure.kind === "threw"
            ? { ...failure, message: truncated(failure.message) }
            : { ...failure, reason: failure.reason === null ? null : truncated(failure.reason) }
    const attempts = await deps.index.deferPending(did, notBeforeMs, kept)
    if (attempts === null) return
    try {
        deps.onSettleFailure?.({ did, attempts, failure: kept, notBeforeMs })
    } catch {}
}

/** `retryCapMs` for `did`, or the default where the deployment gives none. */
export async function retryCapFor(deps: Pick<IngestDeps, "retryCapMs">, did: string): Promise<number> {
    return (await deps.retryCapMs?.(did)) ?? SETTLE_RETRY_CAP_MS
}

export interface SettleFailureEvent {
    did: string
    /** As stored after this failure; a concurrent reset may make it lower
     * than the attempts the retry was scheduled from. */
    attempts: number
    failure: PendingFailure
    notBeforeMs: number
}

/** Which collection this monitor observes. Everything else is dropped. */
export interface IngestConfig {
    collection: string
    /**
     * Under `registered`, a declaration commit for a DID outside the allow
     * list is ignored; under `everyone` every one is taken in, which is how
     * holders are discovered.
     */
    policy: InterestPolicy
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
        // every DID. For one already in the snapshot this is not merely
        // informational: a DID-document rotation changes what the record
        // verifies against, so the record must be read again even though it
        // did not change. `owe` rather than `intake` because the dedupe
        // check would suppress exactly this.
        const known = await deps.index.revOf(event.did)
        // A DID confirmed permanently deleted has no live record to
        // re-verify against. One that is only reversibly gone is re-asked,
        // and `settle` records an answer that repeats the deletion quietly.
        const reverify = known !== null && !(await deps.index.isDeleted(event.did))
        if (reverify) await deps.index.owe(event.did, known, streamTimeUs(cursor))
        // The relay's cached key is dropped for every DID whose document the
        // monitor keeps, declaration or not. After the owe, so a holder that
        // reverifies is watched.
        if (await deps.index.isWatched(event.did)) {
            await deps.keyUpdates?.oweKeyUpdate(event.did, { kind: "delete" })
        }
        return reverify ? "reverify" : "ignored"
    }

    const commit: CommitEvent = event
    if (commit.collection !== config.collection) return "ignored"
    if (config.policy === "registered" && !(await deps.interest.inInterest(commit.did))) {
        return "ignored"
    }

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
    | {
          kind: "verified"
          key: string
          rev: string
          cid: string
          collection?: string
          rkey?: string
          commitCid?: string
          authority?: EvidenceAuthorityIdentity
          assurance?: EvidenceAssurance
          monitor?: string
          /** Canonical hex fingerprint of the validated declaration currentKey, when present. */
          messagingKeyFingerprint?: string | null
      }
    | { kind: "verified-absent"; key: string; rev: string; commitCid?: string }
    /** `reason` says what failed to verify, where the verifier knows. */
    | { kind: "unverifiable"; reason?: string }

/**
 * The source confirmed this DID's declaration is gone. Nothing is left to
 * verify or index by rev, so this skips straight to disposing of what's
 * stored. It still reaches the digest window, the same as a stored change
 * would: `completeDeletion` is `complete`'s deletion-shaped counterpart.
 * `permanent` decides only whether this ALSO suppresses future reverify
 * events (see `MonitorIndex.isDeleted`) — a reversible state (an account
 * takedown/suspension that may lift, or a record the account may publish
 * again) still disposes of the stale snapshot
 * and still pushes, but must stay open to a later event noticing the
 * reversal.
 */
export async function settleDeletion(
    deps: IngestDeps,
    did: string,
    permanent: boolean,
    quiet: boolean,
    cause: GoneCause,
    gen?: number | null
): Promise<void> {
    await deps.snapshot.deleteRecord(did)
    await deps.index.completeDeletion(did, deps.nowMs(), permanent, quiet, cause, gen)
    await raiseSettled(deps, did, null)
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
    /** The pending row's attempts so far; spaces a never-held unverifiable
     * DID's next fetch. 0 where settle is not driven by the retry queue. */
    attempts?: number
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
    const gen = await deps.index.owedGenOf(did)
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
            await deps.index.clearPending(did, gen)
            if (repoLevel) await deps.secondaries?.dispose(did)
            return "deleted"
        }
        // Only a permanent answer for a DID not yet marked deleted is news
        // for one already gone.
        const hardens = err.permanent && !(await deps.index.isDeleted(did))
        const reconfirm = !hardens && (await alreadyGone(deps, did))
        await settleDeletion(deps, did, err.permanent, quiet || reconfirm, "repo", gen)
        if (repoLevel) await deps.secondaries?.dispose(did)
        return "deleted"
    }
    await recordFetchedDocument(deps, did, record.didDocument)

    const outcome = await settleFetched(deps, did, record, quiet, moved, gen, opts.attempts ?? 0)
    // A DID left unwatched has nothing keeping its document current: stop
    // vouching for the one this fetch stored.
    if (!(await deps.index.isWatched(did))) {
        await withdrawFetchedDocument(deps, did, record.didDocument)
    }
    return outcome
}

/**
 * Raises `onSettled`. A throw is swallowed: whatever a deployment keeps
 * beside the index must not hold up the discharge it follows.
 */
export async function raiseSettled(
    deps: IngestDeps,
    did: string,
    settled: SettledDeclaration | null
): Promise<void> {
    try {
        await deps.onSettled?.(did, settled)
    } catch {}
}

/**
 * The declaration is already gone and recorded so: an answer that merely
 * repeats it is no new change, and must not reach the window or `onDelete`
 * again.
 */
async function alreadyGone(deps: IngestDeps, did: string): Promise<boolean> {
    // A snapshot read from KV may be stale; a stale non-null only makes the
    // repeated answer loud, the safe direction.
    if ((await deps.snapshot.getRecord(did)) !== null) return false
    return (await deps.index.holderStateOf(did))?.startsWith("gone-") === true
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
    moved: () => Promise<boolean>,
    gen: number | null,
    attempts: number
): Promise<SettleOutcome> {
    const verified = await deps.verify(did, record)
    if (await moved()) return "left"
    if (verified.kind === "unverifiable") {
        await settleUnverifiable(deps, did, record, gen, attempts, verified.reason)
        return "unverifiable"
    }

    const indexed = await deps.index.revOf(did)
    const movement = compareRev(indexed, verified.rev)
    if (movement === "regressed" && indexed !== null) {
        await deps.onRegression?.(did, indexed, verified.rev)
        await deps.index.clearPending(did, gen)
        return "rejected"
    }

    if (verified.kind === "verified-absent") {
        // The repo is alive and signed to hold no such record. Reversible,
        // because the account may publish it again.
        if (quiet && (await neverHeld(deps, did))) {
            await deps.index.clearPending(did, gen)
            return "deleted"
        }
        await settleDeletion(deps, did, false, quiet || (await alreadyGone(deps, did)), "record", gen)
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
    // every ordinary, non-rotation settle. Evidence needs no previous read
    // on an advance either: the anchors it carries forward were retained in
    // the index when the previous snapshot was stored.
    let previous: SnapshotEntry | null = null
    let keyRotated = false
    if (movement === "unchanged") {
        previous = await deps.snapshot.getRecord(did)
        const previousKey = previous === null ? null : (previous.verifiedWith ?? previous.signingKey)
        keyRotated = previousKey !== null && previousKey !== verified.key
    }
    if (
        previous === null &&
        verified.collection === DECLARATION_COLLECTION_NSID &&
        verified.rkey === "self"
    ) {
        // Key-history tracking needs the prior declaration to distinguish a
        // newly observed rotation from a legacy key whose first-seen date is
        // unknowable. Other records keep the existing no-read fast path.
        previous = await deps.snapshot.getRecord(did)
    }

    const observedAtMs = deps.nowMs()
    const previousEvidence = previous?.evidence ?? null
    const evidence = await prepareSnapshotEvidence(
        deps.index,
        did,
        verified,
        previousEvidence,
        observedAtMs
    )
    // Retained before the put, so a snapshot carrying evidence never exists
    // without its anchors: a put that then fails leaves only rows the retry
    // reuses, and `retainSnapshotEvidence`'s unchanged skip can trust that
    // the evidence a stored snapshot carries is already in the index.
    if (evidence !== null) await retainSnapshotEvidence(deps.index, evidence, previousEvidence)
    let previousMessagingKeyFingerprint = previous?.messagingKeyFingerprint ?? null
    if (previous && previousMessagingKeyFingerprint === null) {
        try {
            const record = readRecordFromCar(previous.car, DECLARATION_COLLECTION_NSID, "self")?.record
            const key = declarationAnchorKeyOf(record)
            if (key) previousMessagingKeyFingerprint = fingerprintKey(key)
        } catch {
            // An unreadable legacy snapshot cannot establish a prior key.
        }
    }
    let messagingKeyFirstSeenAtMs: number | null = null
    if (verified.messagingKeyFingerprint) {
        const history = await deps.index.getMessagingKeyHistory?.(did, verified.messagingKeyFingerprint)
        if (history !== null && history !== undefined) {
            messagingKeyFirstSeenAtMs = history.firstSeenAtMs
        } else if (
            previousMessagingKeyFingerprint !== null &&
            previousMessagingKeyFingerprint !== verified.messagingKeyFingerprint
        ) {
            // Preserve the legacy key as explicitly unknown so a later
            // reappearance cannot be mistaken for a new first observation.
            if ((await deps.index.getMessagingKeyHistory?.(did, previousMessagingKeyFingerprint)) == null) {
                await deps.index.retainMessagingKeyFirstSeen?.(did, {
                    fingerprint: previousMessagingKeyFingerprint,
                    firstSeenAtMs: null,
                    recordCid: previous?.cid ?? null,
                    commitCid: previous?.commitCid ?? null,
                    rev: previous?.rev ?? null,
                    verifiedWith: previous?.verifiedWith ?? previous?.signingKey ?? null,
                })
            }
            // A verified transition is the first trustworthy observation
            // after tracking started, unless this key already has an
            // unknown sentinel from a pre-tracker appearance.
            messagingKeyFirstSeenAtMs = observedAtMs
            await deps.index.retainMessagingKeyFirstSeen?.(did, {
                fingerprint: verified.messagingKeyFingerprint,
                firstSeenAtMs: observedAtMs,
                recordCid: verified.cid,
                commitCid: verified.commitCid ?? null,
                rev: verified.rev,
                verifiedWith: verified.key,
            })
        } else {
            // First observation may be a legacy key. Keep a durable unknown
            // sentinel so it stays unranked if it later disappears/returns.
            await deps.index.retainMessagingKeyFirstSeen?.(did, {
                fingerprint: verified.messagingKeyFingerprint,
                firstSeenAtMs: null,
                recordCid: verified.cid,
                commitCid: verified.commitCid ?? null,
                rev: verified.rev,
                verifiedWith: verified.key,
            })
        }
    }
    await deps.snapshot.putRecord(did, {
        rev: verified.rev,
        commitCid: verified.commitCid ?? null,
        car: record.car,
        observedAtMs,
        source: record.source,
        signingKey: verified.key,
        verifiedWith: verified.key,
        cid: verified.cid,
        evidence,
        messagingKeyFingerprint: verified.messagingKeyFingerprint ?? null,
        messagingKeyFirstSeenAtMs,
    })
    const written = { cid: verified.cid, verifiedWith: verified.key }
    const settled = { rev: verified.rev, cid: verified.cid, car: record.car }
    if (quiet) {
        await deps.index.completeQuietly(did, verified.rev, observedAtMs, written, gen)
        await raiseSettled(deps, did, settled)
        return "stored"
    }
    // Read before `complete`, which marks the DID held again.
    const revived =
        movement !== "advanced" &&
        !keyRotated &&
        (await deps.index.holderStateOf(did))?.startsWith("gone-") === true
    await deps.index.complete(did, verified.rev, observedAtMs, written, gen)
    await raiseSettled(deps, did, settled)

    // A DID back from gone is news at whatever rev it returns.
    if (movement === "advanced" || keyRotated || revived) await deps.onChange?.(did, verified.rev)
    return "stored"
}

function fingerprintKey(key: Uint8Array): string {
    // A digest keeps snapshot KV metadata below Cloudflare's 1 KiB limit;
    // this value is an internal stable identity, not exposed key material.
    return [...sha256(key)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Construct stable evidence identity and reuse the first anchor for a
 * reappearing identity. `previous` is the evidence the stored snapshot
 * carries, where the caller has it; without it, both anchors come from the
 * index, which every evidence-bearing put has already retained them in.
 */
export async function prepareSnapshotEvidence(
    index: MonitorIndex,
    did: string,
    verified: Extract<VerifyOutcome, { kind: "verified" }>,
    previous: SnapshotEvidence | null,
    nowMs: number
): Promise<SnapshotEvidence | null> {
    if (
        verified.commitCid === undefined ||
        verified.authority === undefined ||
        verified.assurance === undefined ||
        verified.monitor === undefined ||
        verified.collection === undefined ||
        verified.rkey === undefined
    ) {
        return null
    }
    const declaration = {
        did,
        collection: verified.collection,
        rkey: verified.rkey,
        recordCid: verified.cid,
        commitCid: verified.commitCid,
        rev: verified.rev,
        verifiedWith: verified.key,
        authority: verified.authority,
    }
    const commitId = commitHistoryId(declaration)
    const anchorId = anchorHistoryId(declaration)
    const sameCommit = previous !== null && commitHistoryId(previous) === commitId
    const sameAnchor = previous !== null && anchorHistoryId(previous) === anchorId
    const commitFirstObservedAtMs = sameCommit
        ? previous!.commitFirstObservedAtMs
        : ((await index.getEvidenceAnchor?.(commitId)) ?? nowMs)
    const anchorFirstObservedAtMs = sameAnchor
        ? previous!.anchorFirstObservedAtMs
        : ((await index.getEvidenceAnchor?.(anchorId)) ?? nowMs)
    return {
        ...declaration,
        assurance: verified.assurance,
        monitor: verified.monitor,
        commitFirstObservedAtMs,
        anchorFirstObservedAtMs,
    }
}

/**
 * Retain the anchors a snapshot about to be stored carries, so a later
 * identity that replaces or deletes it can still reuse them. Nothing is
 * written when `previous` (what the replaced snapshot carried) already held
 * the same identities at the same first observations — an assurance
 * upgrade changes no anchor.
 */
export async function retainSnapshotEvidence(
    index: MonitorIndex,
    evidence: SnapshotEvidence,
    previous: SnapshotEvidence | null = null
): Promise<void> {
    const commit = commitHistoryId(evidence)
    const anchor = anchorHistoryId(evidence)
    if (
        previous !== null &&
        commitHistoryId(previous) === commit &&
        anchorHistoryId(previous) === anchor &&
        previous.commitFirstObservedAtMs === evidence.commitFirstObservedAtMs &&
        previous.anchorFirstObservedAtMs === evidence.anchorFirstObservedAtMs
    ) {
        return
    }
    await index.retainEvidenceAnchors?.(evidence.did, [
        { kind: "commit", identity: commit, firstObservedAtMs: evidence.commitFirstObservedAtMs },
        { kind: "anchor", identity: anchor, firstObservedAtMs: evidence.anchorFirstObservedAtMs },
    ])
}

/** The fields a commit's first observation is keyed by. */
type CommitIdentity = Pick<
    SnapshotEvidence,
    | "did"
    | "collection"
    | "rkey"
    | "recordCid"
    | "commitCid"
    | "rev"
    | "verifiedWith"
    | "authority"
>

function commitHistoryId(e: CommitIdentity): string {
    return JSON.stringify([
        "commit",
        {
            did: e.did,
            collection: e.collection,
            rkey: e.rkey,
            recordCid: e.recordCid,
            commitCid: e.commitCid,
            rev: e.rev,
            verifiedWith: e.verifiedWith,
            authority: e.authority,
        },
    ])
}

function anchorHistoryId(e: Pick<SnapshotEvidence, "did" | "verifiedWith" | "authority">): string {
    return JSON.stringify(["anchor", e.did, e.verifiedWith, e.authority])
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
    record: FetchedRecord,
    gen: number | null,
    attempts: number,
    reason: string | undefined
): Promise<void> {
    const held = (await deps.index.revOf(did)) !== null
    if (held) {
        await deps.index.clearPending(did, gen)
        await deps.index.markAttempted(did, deps.nowMs())
    } else {
        const wait = Math.max(
            deps.unverifiableRetryMs ?? DEFAULT_UNVERIFIABLE_RETRY_MS,
            settleRetryBackoffMs(attempts, await retryCapFor(deps, did))
        )
        await deferFailure(deps, did, deps.nowMs() + wait, {
            kind: "unverifiable",
            reason: reason ?? null,
            atMs: deps.nowMs(),
        })
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
 * stored copy is refreshed again by the next one. Resolves to whether the
 * sink took the document.
 */
export async function recordFetchedDocument(
    deps: Pick<IngestDeps, "didDocuments">,
    did: string,
    fetched: FetchedDidDocument | undefined
): Promise<boolean> {
    if (fetched === undefined || deps.didDocuments === undefined) return false
    try {
        await deps.didDocuments.recordDidDocument(
            did,
            fetched.document,
            fetched.fetchedAtMs - FETCH_AS_OF_SKEW_MS
        )
        return true
    } catch {
        return false
    }
}

/**
 * `recordFetchedDocument` for a DID that is watched: a document is kept only
 * where the export stream keeps it current, so none is stored that nothing
 * will follow. The gate sits at the fetch, not in the sink, which the stream
 * also feeds for permanently deleted DIDs. Never throws: a failed `isWatched`
 * counts as not watched. Resolves to whether the sink took the document, so
 * a caller whose outcome can leave the DID unwatched withdraws only what it
 * stored.
 */
export async function recordWatchedDocument(
    deps: { index: Pick<MonitorIndex, "isWatched">; didDocuments?: DidDocumentSink },
    did: string,
    fetched: FetchedDidDocument | undefined
): Promise<boolean> {
    if (fetched === undefined || deps.didDocuments === undefined) return false
    try {
        if (!(await deps.index.isWatched(did))) return false
    } catch {
        return false
    }
    return recordFetchedDocument(deps, did, fetched)
}

/**
 * Withdraws trust in the stored document `fetched` just wrote, ordered with
 * that write, for a DID no one will keep current.
 */
export async function withdrawFetchedDocument(
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

/**
 * Drain what is owed. Called by the same clock that watches the socket. One
 * DID's failure, or a failure to record it, never costs the rest of the batch.
 */
export async function settleDue(
    deps: IngestDeps,
    limit = 32,
    /** Given the cap `retryCapMs` answered for the DID, so a test cannot
     * skip the cap choice. */
    backoffMs: (attempts: number, capMs: number) => number = settleRetryBackoffMs
): Promise<number> {
    const now = deps.nowMs()
    const due = await deps.index.duePending(now, limit)
    let settled = 0
    for (const p of due) {
        try {
            if (
                (await settle(deps, p.did, { quiet: p.quiet, attempts: p.attempts })) === "stored"
            ) {
                settled += 1
            }
        } catch (err) {
            // A PDS being down is ordinary. The obligation survives; the
            // stream will not redeliver, so the retry queue is the only
            // thing keeping this DID from being silently dropped.
            try {
                const capMs = await retryCapFor(deps, p.did)
                await deferFailure(deps, p.did, now + backoffMs(p.attempts, capMs), {
                    kind: "threw",
                    errorName: err instanceof Error ? err.name : typeof err,
                    message: String(err instanceof Error ? err.message : err),
                    atMs: now,
                })
            } catch (deferErr) {
                // The row keeps its `not_before`, so it is due again next
                // drain; letting this escape would skip the rest of the batch.
                console.error("monitor: settle defer failed", { did: p.did, err: deferErr })
            }
        }
    }
    return settled
}
