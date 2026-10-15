/**
 * The periodic re-check that keeps every held snapshot within the staleness
 * the relay tolerates: confirm each DID's head rev at its source, re-fetch and
 * verify on a move (or when nothing verified is indexed, or the key changed),
 * and record when the snapshot was last confirmed current.
 *
 * A repo rev moves on any commit, so a move whose declaration record CID and
 * key are unchanged is stored quietly — no digest-window entry, no
 * `onChange`. Only a changed record CID or key takes the full `settle` path.
 */
import {
    RecordNotFoundError,
    readRecordFromCar,
    type WatchedRecord,
} from "@germ-network/atproto-pmr-core"
import {
    pushNewlySeenKey,
    recordWatchedDocument,
    withdrawFetchedDocument,
    settle,
    settleDeletion,
    type IngestDeps,
} from "./ingest"
import type { HeadRev } from "./fetch-record"
import { settleSecondary, type SecondaryDeps } from "./secondary"
import { compareRev, type VerifiedWrite } from "./storage"

/** When a stored snapshot was last confirmed current, for the rev it was confirmed at. */
export interface SnapshotCheck {
    rev: string
    checkedAtMs: number
}

export interface RefreshIndex {
    /**
     * The interest set, not deleted and not owed a fetch, not confirmed or
     * attempted since its bound; least recently checked first. A DID with a
     * holder state is due against `checkedBeforeMs`, any other against
     * `nonHolderCheckedBeforeMs`. A reversibly gone holder stays due under
     * `everyone`, so a reversal is found by polling.
     */
    dueRefresh(
        checkedBeforeMs: number,
        limit: number,
        nonHolderCheckedBeforeMs: number
    ): Promise<string[]>
    markChecked(did: string, checkedAtMs: number): Promise<void>
    /**
     * An attempt that did not confirm anything. The DID is not due again
     * until the next interval, so a source that keeps failing, or a record
     * that will not verify, is retried once per interval and cannot starve
     * the rest.
     */
    markAttempted(did: string, attemptedAtMs: number): Promise<void>
    /**
     * A device read found this DID's declaration past the 24-hour rule.
     * Only reorders: a requested DID that `dueRefresh` would return anyway
     * comes first, but a request never makes a DID due, and requested DIDs
     * fill at most a quarter of a batch (at least one), so anonymous reads
     * cannot pin failing sources at the head. Cleared when `dueRefresh`
     * returns the DID, so every refresh outcome consumes it, when the DID
     * leaves interest, or after a day unselected; repeated requests coalesce.
     */
    requestRefresh(did: string, requestedAtMs: number): Promise<void>
    /**
     * The declaration is reversibly gone and already disposed of: re-assert
     * that state, with no digest-window entry and no push.
     */
    markGoneReversible(did: string): Promise<void>

    /** Advance the rev index without a digest-window entry. */
    completeQuietly(
        did: string,
        rev: string,
        observedAtMs: number,
        verified: VerifiedWrite
    ): Promise<void>
}

export interface RefreshSnapshots {
    putCheck(did: string, check: SnapshotCheck): Promise<void>
}

export interface RefreshDeps {
    ingest: IngestDeps
    refreshIndex: RefreshIndex
    refreshSnapshots: RefreshSnapshots
    /**
     * `com.atproto.sync.getLatestCommit` rev, re-resolving the DID document
     * each time, with that document's signing key.
     */
    fetchHeadRev(did: string): Promise<HeadRev>
    collection: string
    rkey: string
    /**
     * The secondaries the same head check covers. One indexed at the head's
     * rev under the current key is confirmed; one behind, missing,
     * unverified or under another key is fetched and settled quietly.
     * `records` is empty where none is kept.
     */
    secondary: { deps: SecondaryDeps; records: readonly WatchedRecord[] }
}

export type RefreshOutcome =
    | "confirmed"
    | "advanced-quiet"
    | "changed"
    | "regressed"
    | "deleted"
    | "failed"

export interface RefreshResult {
    checked: number
    outcomes: Record<RefreshOutcome, number>
}

/**
 * One pass over the DIDs due for a head check, least recently checked
 * first, at most `limit` of them: holders when not confirmed since
 * `nowMs - staleAfterMs`, other DIDs in interest since
 * `nowMs - nonHolderStaleAfterMs`.
 *
 * Anything that is not a confirmation, a quiet advance or a terminal answer
 * is marked attempted and not confirmed, so a source that is down, or a
 * record that does not verify, is retried once per interval rather than
 * recorded as fresh. A regression is raised once per
 * `staleAfterMs` until the source's head moves forward again: the snapshot
 * is not re-confirmed (`chk:` is untouched, so it ages out at the relay),
 * but the alarm is not repeated every pass.
 *
 * A fetched CAR is verified before anything is stored; its record CID then
 * decides whether a move matters.
 */
export async function refreshDue(
    deps: RefreshDeps,
    opts: {
        nowMs: number
        staleAfterMs: number
        limit: number
        /** How stale a never-held DID's snapshots may get. */
        nonHolderStaleAfterMs: number
    }
): Promise<RefreshResult> {
    const dids = await deps.refreshIndex.dueRefresh(
        opts.nowMs - opts.staleAfterMs,
        opts.limit,
        opts.nowMs - opts.nonHolderStaleAfterMs
    )
    const outcomes: Record<RefreshOutcome, number> = {
        confirmed: 0,
        "advanced-quiet": 0,
        changed: 0,
        regressed: 0,
        deleted: 0,
        failed: 0,
    }
    for (const did of dids) {
        let outcome: RefreshOutcome
        try {
            outcome = await refreshOne(deps, did, opts.nowMs)
        } catch {
            outcome = "failed"
            await deps.refreshIndex.markAttempted(did, opts.nowMs).catch(() => {})
        }
        outcomes[outcome] += 1
    }
    return { checked: dids.length, outcomes }
}

/** A terminal answer that is about the repo or the DID, not about one record. */
const repoLevel = (err: RecordNotFoundError) => err.reason !== "RecordNotFound"

async function refreshOne(
    deps: RefreshDeps,
    did: string,
    nowMs: number
): Promise<RefreshOutcome> {
    const { ingest } = deps
    let head: HeadRev
    try {
        head = await deps.fetchHeadRev(did)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        // A repo that does not answer a head read is gone, whatever the name.
        return disposeGone(deps, did, err.permanent, true, nowMs)
    }

    // A DID that never held a declaration has none to fetch: the declaration
    // socket catches a later publish.
    const held = (await ingest.index.revOf(did)) !== null
    const checked = held ? await refreshDeclaration(deps, did, head, nowMs) : null
    const declaration = checked?.outcome ?? null
    if (declaration === "deleted" || declaration === "regressed") return declaration
    // The repo is gone: its secondaries went with it, and fetching them again
    // would only be handed the same answer.
    if (checked !== null && checked.repoGone) return checked.outcome

    const secondaries = await refreshSecondaries(deps, did, head, nowMs)
    if (secondaries === "failed") {
        await deps.refreshIndex.markAttempted(did, nowMs)
        return "failed"
    }
    if (declaration !== null && declaration !== "confirmed") return declaration
    if (declaration === null) await deps.refreshIndex.markChecked(did, nowMs)
    return secondaries
}

async function refreshDeclaration(
    deps: RefreshDeps,
    did: string,
    head: HeadRev,
    nowMs: number
): Promise<{ outcome: RefreshOutcome; repoGone: boolean }> {
    const { ingest } = deps
    const indexed = await ingest.index.revOf(did)
    const movement = compareRev(indexed, head.rev)
    if (movement === "regressed" && indexed !== null) {
        await ingest.onRegression?.(did, indexed, head.rev)
        await deps.refreshIndex.markChecked(did, nowMs)
        return { outcome: "regressed", repoGone: false }
    }
    if (movement === "unchanged" && indexed !== null) {
        if (!(await needsReverify(deps, did, head))) {
            await confirm(deps, did, indexed, nowMs)
            return { outcome: "confirmed", repoGone: false }
        }
    }

    // The head moved, but a repo rev moves on any commit. Only a different
    // declaration record (or a re-keyed DID document, which `settle` reports
    // to a registered device) is a change worth a digest-window entry.
    let fetched
    try {
        fetched = await ingest.fetchRecord(did)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        return {
            outcome: await disposeGone(deps, did, err.permanent, repoLevel(err), nowMs),
            repoGone: repoLevel(err),
        }
    }
    const recorded = await recordWatchedDocument(ingest, did, fetched.didDocument)
    const verified = await ingest.verify(did, fetched)
    if (verified.kind === "unverifiable") {
        // Not evidence of anything: the stored record stands and the DID is
        // retried next interval. Only a newly seen key is recorded and pushed.
        await deps.refreshIndex.markAttempted(did, nowMs)
        await pushNewlySeenKey(ingest, did, fetched.signingKey)
        return { outcome: "failed", repoGone: false }
    }
    if (verified.kind === "verified-absent") {
        // A 200 with an exclusion proof: the repo is alive and the record is
        // gone. Reversible, because the account may publish it again.
        const outcome = await disposeGone(deps, did, false, false, nowMs)
        // A document stored for a DID this left unwatched would be trusted
        // with nothing following it. Unguarded on purpose: a failed check is
        // not "unwatched", and the caller marks the DID attempted.
        if (recorded && !(await ingest.index.isWatched(did))) {
            await withdrawFetchedDocument(ingest, did, fetched.didDocument)
        }
        return { outcome, repoGone: false }
    }
    const incoming = readRecordFromCar(fetched.car, deps.collection, deps.rkey)

    const previous = await ingest.snapshot.getRecord(did)
    const previousRecord =
        previous === null
            ? null
            : readRecordFromCar(previous.car, deps.collection, deps.rkey)
    const previousKey = previous === null ? null : (previous.verifiedWith ?? previous.signingKey)
    const rekeyed = previousKey !== null && previousKey !== verified.key
    const quiet =
        previousRecord !== null &&
        incoming !== null &&
        previousRecord.cid === incoming.cid &&
        !rekeyed &&
        compareRev(indexed, verified.rev) !== "regressed"
    if (!quiet) {
        // `settle` re-fetches; the extra read is the price of one code path
        // for everything that is a real change.
        await settle(ingest, did)
        return { outcome: "changed", repoGone: false }
    }

    await ingest.snapshot.putRecord(did, {
        rev: verified.rev,
        car: fetched.car,
        observedAtMs: nowMs,
        source: fetched.source,
        signingKey: verified.key,
        verifiedWith: verified.key,
        cid: verified.cid,
    })
    await deps.refreshIndex.completeQuietly(did, verified.rev, nowMs, {
        cid: verified.cid,
        verifiedWith: verified.key,
    })
    await confirm(deps, did, verified.rev, nowMs)
    return { outcome: "advanced-quiet", repoGone: false }
}

/**
 * The same head read covers each secondary. One indexed at the head's rev
 * under the head's key is confirmed; one behind, missing, unverified or under
 * another key is fetched and settled, which stores it at its signed rev
 * without a window entry or a push. Any that did not end up current (an
 * unverifiable answer, a repo-level one handed to the declaration) makes the
 * pass `failed`, so it is retried next interval.
 */
async function refreshSecondaries(
    deps: RefreshDeps,
    did: string,
    head: HeadRev,
    nowMs: number
): Promise<"confirmed" | "advanced-quiet" | "failed"> {
    const { deps: secondary, records } = deps.secondary
    if (records.length === 0 || !(await deps.ingest.interest.inInterest(did))) return "confirmed"
    const rows = await deps.ingest.index.recordsOf(did)
    let outcome: "confirmed" | "advanced-quiet" | "failed" = "confirmed"
    for (const r of records) {
        const ref = { did, collection: r.collection, rkey: r.rkey }
        const row = rows.find((x) => x.collection === r.collection && x.rkey === r.rkey)
        if (row !== undefined && row.rev === head.rev && row.verifiedWith === head.signingKey) {
            await secondary.snapshot.putSecondaryCheck(ref, { rev: row.rev, checkedAtMs: nowMs })
            continue
        }
        const epoch = await deps.ingest.interest.interestEpoch(did)
        const settled = await settleSecondary(secondary, {
            ...ref,
            rev: head.rev,
            attempts: 0,
            notBeforeMs: 0,
            epoch,
        })
        if (settled === "stored" || settled === "deleted") {
            if (outcome === "confirmed") outcome = "advanced-quiet"
        } else if (settled !== "older") {
            outcome = "failed"
        }
    }
    return outcome
}

/**
 * An unchanged head still needs a fetch when nothing was ever verified for
 * the declaration (a snapshot stored before ingest verified), or it verified
 * under a key other than the one the document now carries, including no key.
 * A declaration already known reversibly gone has no row by design and is
 * left to the next event or head move.
 */
async function needsReverify(deps: RefreshDeps, did: string, head: HeadRev): Promise<boolean> {
    const rows = await deps.ingest.index.recordsOf(did)
    const held = rows.find((r) => r.collection === deps.collection && r.rkey === deps.rkey)
    if (held !== undefined) return held.verifiedWith !== head.signingKey
    return (await deps.ingest.index.holderStateOf(did)) !== "gone-reversible"
}

/**
 * The declaration, or the whole repo, is gone.
 *
 * A DID never held has nothing to tell anyone and nothing indexed to mark: a
 * repo-level answer disposes its secondaries and leaves it on its own
 * cadence; no `deleted` row, window entry, push or holder state is written.
 *
 * A held DID's reversible deletion leaves it indexed, so it comes due again
 * every pass. Only the first sighting is a change worth a window entry and a
 * push; after that the snapshot is already gone and the answer is merely
 * re-confirmed. A repo-level answer takes the secondaries with it.
 */
async function disposeGone(
    deps: RefreshDeps,
    did: string,
    permanent: boolean,
    repoWide: boolean,
    nowMs: number
): Promise<RefreshOutcome> {
    const { ingest } = deps
    if ((await ingest.index.revOf(did)) === null) {
        if (repoWide) await ingest.secondaries?.dispose(did)
        await deps.refreshIndex.markChecked(did, nowMs)
        return "deleted"
    }
    let outcome: RefreshOutcome
    if ((await ingest.snapshot.getRecord(did)) === null) {
        // An earlier reversible answer can harden into a permanent one.
        if (permanent && !(await ingest.index.isDeleted(did))) {
            await settleDeletion(ingest, did, true)
            outcome = "deleted"
        } else {
            if (!permanent) await deps.refreshIndex.markGoneReversible(did)
            await deps.refreshIndex.markChecked(did, nowMs)
            outcome = "confirmed"
        }
    } else {
        await settleDeletion(ingest, did, permanent)
        outcome = "deleted"
    }
    if (repoWide) await ingest.secondaries?.dispose(did)
    return outcome
}

async function confirm(
    deps: RefreshDeps,
    did: string,
    rev: string,
    nowMs: number
): Promise<void> {
    await deps.refreshIndex.markChecked(did, nowMs)
    await deps.refreshSnapshots.putCheck(did, { rev, checkedAtMs: nowMs })
}
