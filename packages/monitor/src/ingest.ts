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
        // every DID. Only those already in the snapshot matter, and for
        // them a re-key changes what their record verifies against.
        const known = await deps.index.revOf(event.did)
        return known === null ? "ignored" : "reverify"
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
 * Steps 2 and 3, off the read loop. Safe to call for a DID owed more than
 * once — the fetch is by DID, not by event, so a burst of revs for one DID
 * collapses into a single authoritative read.
 */
export async function settle(deps: IngestDeps, did: string): Promise<void> {
    const record = await deps.fetchRecord(did)

    if (deps.verify !== undefined && !(await deps.verify(did, record))) {
        // A record that fails verification is not evidence of anything the
        // monitor may serve: leave the obligation owed and say nothing.
        return
    }

    const indexed = await deps.index.revOf(did)
    const movement = compareRev(indexed, record.rev)
    if (movement === "regressed" && indexed !== null) {
        await deps.onRegression?.(did, indexed, record.rev)
        return
    }

    const observedAtMs = deps.nowMs()
    await deps.snapshot.putRecord(did, {
        rev: record.rev,
        car: record.car,
        observedAtMs,
    })
    await deps.index.complete(did, record.rev, observedAtMs)

    if (movement === "advanced") await deps.onChange?.(did, record.rev)
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
            await settle(deps, p.did)
            settled += 1
        } catch {
            // A PDS being down is ordinary. The obligation survives; the
            // stream will not redeliver, so the retry queue is the only
            // thing keeping this DID from being silently dropped.
            await deps.index.deferPending(p.did, now + backoffMs(p.attempts))
        }
    }
    return settled
}
