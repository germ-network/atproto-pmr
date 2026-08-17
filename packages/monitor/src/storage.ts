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

/**
 * A position in the upstream stream, in whatever units the stream uses
 * (Jetstream: microseconds). Opaque: a monitor stores and replays it, and
 * never compares it to anything of its own.
 */
export type Cursor = string

/**
 * A position in **this monitor's own observation clock**, milliseconds.
 *
 * Deliberately a different type from `Cursor`, because they were briefly
 * the same one and the bug that produced is instructive: a stream cursor
 * in microseconds compared against an observation time in milliseconds is
 * off by a factor of a thousand, so the comparison silently answers
 * "nothing changed" forever rather than failing. A client's delta cursor
 * is issued by the monitor, from `nextCursor`, and is never the stream
 * position.
 */
export type DeltaCursor = string

/** What the monitor serves for one DID: the verified bytes and their rev. */
export interface SnapshotEntry {
    rev: string
    /** The record as CAR — never a parsed form; the client verifies it. */
    car: Uint8Array
    observedAtMs: number
    /** The PDS this was fetched from. */
    source: string
    /**
     * The atproto repo signing key resolved at fetch time, `null` if the
     * DID document carried none. Provenance, not a check this monitor
     * performed — see `compareObservations`.
     */
    signingKey: string | null
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
     * Record an obligation regardless of what the index already knows.
     *
     * Distinct from `intake` because two cases need a fetch the dedupe
     * check would suppress: a DID-document rotation, where the record is
     * unchanged but what it verifies against is not, and any operator-
     * driven re-check.
     */
    owe(did: string, rev: string): Promise<void>

    /**
     * Discharge an obligation **without** indexing anything.
     *
     * For outcomes that are terminal but unstorable — a regression, a
     * record that failed verification. The look happened and the answer
     * was an alarm; leaving the row would retry the same answer in a hot
     * loop against the very DID under attack.
     */
    clearPending(did: string): Promise<void>

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
     * Windows that have closed and hold members, oldest first.
     *
     * A window is indexed by **observation time** — when this monitor
     * confirmed the change — not by when the change happened. The retry
     * path forces it: a DID whose PDS was down settles hours late, and a
     * sealed Bloom filter cannot be amended, so indexing by event time
     * would drop that change into a window already published and make it
     * permanently invisible. The cost is a fact clients depend on: a
     * digest window says when this monitor *saw* a change, so window
     * numbers are monitor-local and only `rev` is comparable across
     * monitors.
     */
    closedWindowsWithMembers(currentWindow: number, limit: number): Promise<number[]>

    /** The DIDs recorded in one window. */
    windowMembers(window: number): Promise<string[]>

    /** Drop a window's membership once its filter is durable. */
    dropWindow(window: number): Promise<void>

    /**
     * The highest window sealed so far — the boundary between "definitely
     * nothing changed" and "not published yet".
     *
     * Advances past empty windows too. A quiet interval and an interval
     * this monitor was down are the same thing under observation-time
     * indexing: nothing was observed, so nothing is reported, and the
     * backlog lands in whichever window it is finally confirmed in.
     */
    readSealedThrough(): Promise<number | null>
    setSealedThrough(window: number): Promise<void>

    /**
     * Which of `dids` changed since `cursor`. The reason the index exists
     * rather than living wholly in the snapshot: a key-value serving store
     * can neither answer this nor promise read-your-writes.
     */
    changedSince(
        dids: readonly string[],
        since: DeltaCursor | null
    ): Promise<{ dids: string[]; nextCursor: DeltaCursor }>
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

/**
 * What `compareObservations` needs from one monitor's report of a DID —
 * the fields of a `SnapshotEntry` that carry provenance, plus the bytes
 * being compared. Deliberately not `SnapshotEntry` itself: `observedAtMs`
 * is monitor-local (`MonitorIndex.closedWindowsWithMembers`) and has no
 * meaning across two independent monitors, so it plays no part here.
 */
export interface Observation {
    rev: string
    source: string
    signingKey: string | null
    car: Uint8Array
}

/**
 * What two independent observations of the same DID mean, together.
 *
 * Unlike `compareRev` — one monitor's own history, strictly ordered —
 * these are two parties with no shared history, so there is no
 * "regressed": only whether they agree, and if not, why.
 */
export type ObservationComparison =
    /** Same authority, same rev, same bytes. Nothing to resolve. */
    | "agree"
    /** Same authority, differing rev. Ordinary — one side is merely older;
     * `observedAtMs`, outside this function, is what could say which. */
    | "skew"
    /** Same authority, same rev, DIFFERING bytes. Provable misconduct: the
     * DID's own key signed two different states under one rev label. */
    | "equivocation"
    /** Differing `signingKey`. The DID document moved between the two
     * observations — a question for the PLC log, not for these records. */
    | "rotated"
    /** Same authority, same rev, same bytes, different `source`. Not an
     * alarm — a mirror or a migration in flight — but worth surfacing
     * separately from `agree`, since a reader may still want to know the
     * two monitors are not reading the same host. */
    | "different-source"

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/**
 * Classify what two monitors' observations of one DID mean, per
 * `spec/key-transparency.md`'s comparison rule: **compare under a common
 * authority, or not at all**. `signingKey` is checked first and pre-empts
 * everything else — a `rev` or content comparison made across a rotation
 * answers a question neither observation was actually asked.
 *
 * That check only *fires* when both sides resolved a key: a `null` on
 * either side means rotation cannot be asserted (there is nothing to
 * compare it against), not that it is ruled out, so comparison falls
 * through to `rev`/content. That fallback stays sound with an unknown
 * authority: `equivocation` is proven by `rev` equality plus a content
 * difference alone — each side's bytes were independently valid CARs when
 * fetched — so nothing above needs a confirmed shared key to hold.
 */
export function compareObservations(
    a: Observation,
    b: Observation
): ObservationComparison {
    if (a.signingKey !== null && b.signingKey !== null && a.signingKey !== b.signingKey) {
        return "rotated"
    }
    if (a.rev !== b.rev) {
        return "skew"
    }
    if (!bytesEqual(a.car, b.car)) {
        return "equivocation"
    }
    return a.source === b.source ? "agree" : "different-source"
}
