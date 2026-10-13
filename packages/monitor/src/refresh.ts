/**
 * The periodic re-check that keeps every held snapshot under the relay's
 * staleness the relay tolerates: confirm each DID's head rev at its source, re-fetch on a move,
 * and record when the snapshot was last confirmed current.
 *
 * A repo rev moves on any commit, so a move whose declaration record CID is
 * unchanged is stored quietly — no digest-window entry, no `onChange`.
 * Only a changed record CID takes the full `settle` path.
 */
import { RecordNotFoundError, readRecordFromCar } from "@germ-network/atproto-pmr-core"
import { settle, settleDeletion, type IngestDeps } from "./ingest"
import { compareRev } from "./storage"

/** When a stored snapshot was last confirmed current, for the rev it was confirmed at. */
export interface SnapshotCheck {
    rev: string
    checkedAtMs: number
}

export interface RefreshIndex {
    /** Held, not deleted, not pending; least recently checked first. */
    dueRefresh(checkedBeforeMs: number, limit: number): Promise<string[]>
    markChecked(did: string, checkedAtMs: number): Promise<void>
    /**
     * An attempt that did not confirm anything. Moves the DID to the back of
     * the queue so a persistently failing source cannot starve the rest; it
     * stays due, because it does not count as a confirmation.
     */
    markAttempted(did: string, attemptedAtMs: number): Promise<void>
    /** Advance the rev index without a digest-window entry. */
    completeQuietly(did: string, rev: string, observedAtMs: number): Promise<void>
}

export interface RefreshSnapshots {
    putCheck(did: string, check: SnapshotCheck): Promise<void>
}

export interface RefreshDeps {
    ingest: IngestDeps
    refreshIndex: RefreshIndex
    refreshSnapshots: RefreshSnapshots
    /** `com.atproto.sync.getLatestCommit` rev, re-resolving the DID document each time. */
    fetchHeadRev(did: string): Promise<string>
    collection: string
    rkey: string
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
 * One pass over the DIDs not confirmed since `nowMs - staleAfterMs`, least
 * recently checked first, at most `limit` of them.
 *
 * Anything that is not a confirmation, a quiet advance or a terminal answer
 * leaves the DID due (queued behind the rest), so a source that is down is
 * retried rather than recorded as fresh. A regression is raised once per
 * `staleAfterMs` until the source's head moves forward again: the snapshot
 * is not re-confirmed (`chk:` is untouched, so it ages out at the relay),
 * but the alarm is not repeated every pass.
 *
 * A moved head is compared by record CID only to decide whether the move
 * matters; the monitor still never verifies signatures here.
 */
export async function refreshDue(
    deps: RefreshDeps,
    opts: { nowMs: number; staleAfterMs: number; limit: number }
): Promise<RefreshResult> {
    const dids = await deps.refreshIndex.dueRefresh(
        opts.nowMs - opts.staleAfterMs,
        opts.limit
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

async function refreshOne(
    deps: RefreshDeps,
    did: string,
    nowMs: number
): Promise<RefreshOutcome> {
    const { ingest } = deps
    let head: string
    try {
        head = await deps.fetchHeadRev(did)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        return disposeGone(deps, did, err.permanent, nowMs)
    }

    const indexed = await ingest.index.revOf(did)
    const movement = compareRev(indexed, head)
    if (movement === "regressed" && indexed !== null) {
        await ingest.onRegression?.(did, indexed, head)
        await deps.refreshIndex.markChecked(did, nowMs)
        return "regressed"
    }
    if (movement === "unchanged" && indexed !== null) {
        await confirm(deps, did, indexed, nowMs)
        return "confirmed"
    }

    // The head moved, but a repo rev moves on any commit. Only a different
    // declaration record (or a re-keyed DID document, which `settle` reports
    // to a registered device) is a change worth a digest-window entry.
    let fetched
    try {
        fetched = await ingest.fetchRecord(did)
    } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err
        return disposeGone(deps, did, err.permanent, nowMs)
    }
    const incoming = readRecordFromCar(fetched.car, deps.collection, deps.rkey)
    if (incoming === null) {
        // A 200 with an exclusion proof: the repo is alive and the record is
        // gone. Reversible, because the account may publish it again.
        return disposeGone(deps, did, false, nowMs)
    }

    const previous = await ingest.snapshot.getRecord(did)
    const previousRecord =
        previous === null
            ? null
            : readRecordFromCar(previous.car, deps.collection, deps.rkey)
    const rekeyed =
        previous !== null &&
        previous.signingKey !== null &&
        fetched.signingKey !== null &&
        previous.signingKey !== fetched.signingKey
    const quiet =
        ingest.verify === undefined &&
        previousRecord !== null &&
        previousRecord.cid === incoming.cid &&
        !rekeyed &&
        compareRev(indexed, fetched.rev) === "advanced"
    if (!quiet) {
        // `settle` re-fetches; the extra read is the price of one code path
        // for everything that is a real change.
        await settle(ingest, did)
        return "changed"
    }

    await ingest.snapshot.putRecord(did, {
        rev: fetched.rev,
        car: fetched.car,
        observedAtMs: nowMs,
        source: fetched.source,
        signingKey: fetched.signingKey,
    })
    await deps.refreshIndex.completeQuietly(did, fetched.rev, nowMs)
    await confirm(deps, did, fetched.rev, nowMs)
    return "advanced-quiet"
}

/**
 * A reversible deletion leaves the DID indexed, so it comes due again every
 * pass. Only the first sighting is a change worth a window entry and a push;
 * after that the snapshot is already gone and the answer is merely re-confirmed.
 */
async function disposeGone(
    deps: RefreshDeps,
    did: string,
    permanent: boolean,
    nowMs: number
): Promise<RefreshOutcome> {
    if ((await deps.ingest.snapshot.getRecord(did)) === null) {
        // An earlier reversible answer can harden into a permanent one.
        if (permanent && !(await deps.ingest.index.isDeleted(did))) {
            await settleDeletion(deps.ingest, did, true)
            return "deleted"
        }
        await deps.refreshIndex.markChecked(did, nowMs)
        return "confirmed"
    }
    await settleDeletion(deps.ingest, did, permanent)
    return "deleted"
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
