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

import type { CommitEvent, MonitorEvent } from "./jetstream"
import {
    compareRev,
    type Cursor,
    type MonitorIndex,
    type SnapshotStore,
} from "./storage"

/** The authoritative record, as fetched from the DID's own PDS. */
export interface FetchedRecord {
    rev: string
    car: Uint8Array
    /** The PDS this was fetched from. */
    source: string
    /** The atproto signing key resolved at fetch time; `null` if the DID
     * document carried none. See `resolvePDSEndpoint` in core. */
    signingKey: string | null
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
     * Optional defense in depth. A monitor that forwards what it fetched
     * needs no CAR parser — the client verifies against the DID document —
     * so verification is a seam rather than a dependency.
     */
    verify?(did: string, record: FetchedRecord): Promise<boolean>
    /** Own-DID push, where a registration holds this DID. */
    onChange?(did: string, rev: string): Promise<void>
    /** Raised when an observed rev moves backwards. Never silent. */
    onRegression?(did: string, indexed: string, observed: string): Promise<void>
    nowMs(): number
}

/** Which collection this monitor observes. Everything else is dropped. */
export interface IngestConfig {
    collection: string
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
        await deps.index.owe(event.did, known)
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
 * the very DID under attack, forever, with the same answer.
 */
export type SettleOutcome = "stored" | "rejected"

/**
 * Steps 2 and 3, off the read loop. Safe to call for a DID owed more than
 * once — the fetch is by DID, not by event, so a burst of revs for one DID
 * collapses into a single authoritative read.
 *
 * Throws only on *transient* failure (the PDS is unreachable), which is
 * what tells the caller to retry with backoff.
 */
export async function settle(deps: IngestDeps, did: string): Promise<SettleOutcome> {
    const record = await deps.fetchRecord(did)

    if (deps.verify !== undefined && !(await deps.verify(did, record))) {
        // Not evidence of anything the monitor may serve. Terminal, not
        // transient: the same bytes will fail again next time.
        await deps.index.clearPending(did)
        return "rejected"
    }

    const indexed = await deps.index.revOf(did)
    const movement = compareRev(indexed, record.rev)
    if (movement === "regressed" && indexed !== null) {
        await deps.onRegression?.(did, indexed, record.rev)
        await deps.index.clearPending(did)
        return "rejected"
    }

    const observedAtMs = deps.nowMs()
    await deps.snapshot.putRecord(did, {
        rev: record.rev,
        car: record.car,
        observedAtMs,
        source: record.source,
        signingKey: record.signingKey,
    })
    await deps.index.complete(did, record.rev, observedAtMs)

    if (movement === "advanced") await deps.onChange?.(did, record.rev)
    return "stored"
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
            if ((await settle(deps, p.did)) === "stored") settled += 1
        } catch {
            // A PDS being down is ordinary. The obligation survives; the
            // stream will not redeliver, so the retry queue is the only
            // thing keeping this DID from being silently dropped.
            await deps.index.deferPending(p.did, now + backoffMs(p.attempts))
        }
    }
    return settled
}
