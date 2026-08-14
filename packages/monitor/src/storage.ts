/**
 * The monitor's storage seam, split the way the data's own properties split
 * it (`docs/monitor-ingest.md`, "State partition").
 *
 * Two stores, because two access patterns:
 *
 * - `SnapshotStore` holds bytes the monitor merely *serves* — records and
 *   sealed digest windows. Public, re-fetchable, read-heavy, write-rare.
 *   Eventual consistency is acceptable here and only here: a stale read is
 *   `rev` skew, which the trust model already treats as ordinary.
 * - `MonitorIndex` holds the small state the monitor must *compare and
 *   query* under a single writer — the cursor, the `rev` index, pending
 *   fetches, and the open digest window.
 *
 * `rev` comparisons MUST read the index, never the snapshot: the snapshot
 * is a serving copy, not a truth.
 */

/** An opaque resume position. Never parsed by a monitor. */
export type Cursor = string

/** What the monitor serves for one DID: the verified bytes and their rev. */
export interface SnapshotEntry {
    rev: string
    /** The record as CAR — never a parsed form; the client verifies it. */
    car: Uint8Array
    observedAtMs: number
}

/**
 * Serving-side storage. Entries carry **no TTL**: a record unchanged for
 * years must still be served. Disposable in the only sense that matters —
 * rebuildable from replay.
 */
export interface SnapshotStore {
    getRecord(did: string): Promise<SnapshotEntry | null>
    putRecord(did: string, entry: SnapshotEntry): Promise<void>
    /** Absent once past the published retention; a client then re-verifies. */
    getSealedWindow(windowId: string): Promise<Uint8Array | null>
    putSealedWindow(windowId: string, filter: Uint8Array): Promise<void>
}

/** A fetch the monitor owes: recorded at intake, cleared on completion. */
export interface PendingFetch {
    did: string
    /** The rev that prompted it — not necessarily the rev finally observed. */
    rev: string
    attempts: number
    notBeforeMs: number
}

export type IntakeOutcome =
    /** Already applied. The common case just after a reconnect. */
    | { outcome: "duplicate" }
    /** Newly owed; a pending row now exists and the cursor has advanced. */
    | { outcome: "accepted" }

/**
 * Single-writer state. Every method here is called by the one consumer;
 * none is on a read path.
 */
export interface MonitorIndex {
    readCursor(): Promise<Cursor | null>

    /**
     * Record an event as owed, and advance the cursor, **atomically**.
     *
     * Both halves in one step or neither: a cursor that advanced without
     * the obligation would skip the event on the next resume, and the
     * obligation without the cursor would replay it forever. Returns
     * `duplicate` — without writing a pending row — when `rev` is already
     * indexed, which is what makes a reconnect's replayed backlog cheap.
     */
    intake(event: { did: string; rev: string }, cursor: Cursor): Promise<IntakeOutcome>

    /**
     * Apply a completed fetch: index the rev, add the DID to the open
     * window, clear the pending row — **atomically**, and only after the
     * bytes are durable in the `SnapshotStore`.
     */
    complete(did: string, rev: string, observedAtMs: number): Promise<void>

    /** Retry queue. A fetch that failed is owed until it succeeds. */
    duePending(nowMs: number, limit: number): Promise<PendingFetch[]>
    deferPending(did: string, notBeforeMs: number): Promise<void>

    /** The indexed rev, for regression detection and duplicate suppression. */
    revOf(did: string): Promise<string | null>

    /**
     * Which of `dids` changed since `cursor`. The reason the index exists
     * rather than living wholly in the snapshot: a key-value serving store
     * can neither answer this nor promise read-your-writes.
     */
    changedSince(dids: readonly string[], cursor: Cursor | null): Promise<string[]>
}

/**
 * A `rev` that moved backwards is the alarm the whole component exists to
 * raise — a rollback, or a publisher equivocating
 * (`spec/trust-model.md`). Sweeps are compare-only against the index and
 * MUST NOT be a source for it: a sweep sees current state, not history, so
 * an index rebuilt from one would adopt an outage-window rollback as its
 * baseline.
 */
export type RevComparison = "unchanged" | "advanced" | "regressed"

/**
 * atproto revs are TIDs — lexicographically sortable, so ordering needs no
 * parsing.
 */
export function compareRev(indexed: string | null, observed: string): RevComparison {
    if (indexed === null || indexed === observed) {
        return indexed === null ? "advanced" : "unchanged"
    }
    return observed > indexed ? "advanced" : "regressed"
}
