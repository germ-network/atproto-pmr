/**
 * The monitor's storage seam, split the way the data's own properties split
 * it (`docs/monitor-ingest.md`, "State partition").
 *
 * Two stores, because two access patterns — and, since the DO-read-offload,
 * two *processes*: `SnapshotStore` is the only thing a request handler may
 * touch. `MonitorIndex` is write-path state private to the single writer
 * that holds the stream; no read route may reach it, a boundary
 * `ServeDeps` (`digest.ts`) enforces by not carrying an index at all.
 *
 * - `SnapshotStore` holds bytes the monitor *serves* — records, sealed
 *   digest windows, and the digest marker. Public, re-fetchable,
 *   read-heavy, write-rare. Eventual consistency is acceptable here and
 *   only here: a stale read is `rev` skew (or, for the marker, a
 *   replication lag `serveDigest` detects and stops at), which the trust
 *   model already treats as ordinary.
 * - `MonitorIndex` holds the small state that must be *compared and
 *   queried* under a single writer — the cursor, the `rev` index, pending
 *   fetches, and the open (unsealed) digest window's membership. Once a
 *   window closes, its membership is sealed to `SnapshotStore` and the
 *   index's copy is dropped — the index never holds anything a read route
 *   needs.
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
 * The digest's own read cursor onto `SnapshotStore` — the two facts
 * `serveDigest` needs and cannot derive from a window it does not yet
 * have: how far sealing has actually reached, and how far back coverage
 * still goes.
 *
 * Published as one object, not two keys, so a reader never observes them
 * at different points in time relative to each other — only relative to
 * the window bytes, which `serveDigest` already treats as possibly lagging
 * (a missing window below `sealedThrough` is what a KV read replica behind
 * the write looks like, not evidence that nothing happened).
 */
export interface DigestMarker {
    /** The newest window sealing has confirmed, published-side. */
    sealedThrough: number
    /**
     * The earliest window still retained. **Monotonic once published** —
     * never allowed to move earlier — because a retention *increase* must
     * not retroactively promise coverage for windows whose bytes already
     * expired from `SnapshotStore` under the old, shorter retention.
     */
    oldest: number
}

/**
 * Serving-side storage. Records carry **no TTL**: unchanged for years must
 * still be served, disposable only in the sense that it is rebuildable
 * from replay. Sealed windows and the marker are written once per window
 * and never revised — a window cannot be rebuilt once its membership is
 * dropped, and the marker only ever advances.
 */
export interface SnapshotStore {
    getRecord(did: string): Promise<SnapshotEntry | null>
    putRecord(did: string, entry: SnapshotEntry): Promise<void>
    /**
     * The one case a record is disposed of outright, unlike the "no TTL"
     * rule above: a confirmed deletion at the source (the PDS's own XRPC
     * error body named a terminal state for this DID's declaration, not
     * merely being unreachable). Continuing to serve a stale CAR after
     * that would be actively misleading — the community view would claim
     * to hold proof of a record that no longer exists to be proven. A
     * no-op if nothing was stored for `did`.
     */
    deleteRecord(did: string): Promise<void>
    /** Absent means either genuinely unsealed, or not yet propagated to
     * this replica — `serveDigest` is what tells those apart, using
     * `getDigestMarker`; this store makes no claim either way. */
    getSealedWindow(windowId: string): Promise<Uint8Array | null>
    putSealedWindow(windowId: string, filter: Uint8Array): Promise<void>
    /** `null` before the first window has ever sealed — a fresh deploy, or
     * a wake ahead of the first watchdog tick. Not an error state. */
    getDigestMarker(): Promise<DigestMarker | null>
    putDigestMarker(marker: DigestMarker): Promise<void>
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
     * The DIDs recorded in one window — a window is indexed by
     * **observation time**, when this monitor confirmed the change, not
     * when the change happened. The retry path forces it: a DID whose PDS
     * was down settles hours late, and a sealed Bloom filter cannot be
     * amended, so indexing by event time would drop that change into a
     * window already published and make it permanently invisible. The
     * cost is a fact clients depend on: a digest window says when this
     * monitor *saw* a change, so window numbers are monitor-local and
     * only `rev` is comparable across monitors.
     *
     * Answers `[]` for a window with no members exactly as it would for
     * one that never existed — `sealDueWindows` reads every window in
     * range this way, empty or not, so nothing here needs to distinguish
     * the two.
     */
    windowMembers(window: number): Promise<string[]>

    /** Drop a window's membership once its filter is durable. A no-op if
     * the window held none, which is the ordinary case for a quiet one. */
    dropWindow(window: number): Promise<void>

    /**
     * Progress through tier 3's baseline build (`docs/monitor-ingest.md`,
     * "Reconciliation") — a second position, distinct from `Cursor` (the
     * live tail): this monitor's own place in a relay's enumeration of
     * every DID carrying the collection.
     *
     * Exists because the live tail alone only sees a DID from the moment
     * this monitor's connection opened — anything published earlier and
     * not touched since is invisible without this.
     */
    readBackfillProgress(): Promise<BackfillProgress>
    setBackfillProgress(progress: BackfillProgress): Promise<void>
}

/**
 * `done: false` carries `cursor: null` before the first page and the
 * relay's own opaque cursor between pages — the same "resume where you
 * left off, uninterpreted" shape as `Cursor`. `done: true` is terminal:
 * the relay's enumeration was exhausted, so nothing remains to discover
 * this way. (Re-sweeping periodically, to catch a relay that withholds a
 * DID from one pass, is `docs/monitor-ingest.md`'s separate "Withholding
 * sweep" — not implemented by this baseline-build pass.)
 */
export type BackfillProgress =
    | { done: false; cursor: string | null }
    | { done: true }

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
 * being compared. Deliberately not `SnapshotEntry` itself: digest window
 * numbering is monitor-local and not comparable across two independent
 * monitors, but `observedAtMs` — a wall-clock reading — plays no part in
 * the classification below only because this function does not need it
 * to; a caller comparing two `skew` observations may still want it to
 * guess which side is older.
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
    /** Same authority, same rev, DIFFERING bytes. The strongest signal
     * this function can raise, but **evidence to escalate, not proof**: a
     * CAR's own block ordering is not required to be deterministic
     * (atproto's own spec says so), so two honest fetches of the identical
     * commit — different PDS software, or one upgraded between the two
     * reads — can differ byte-for-byte without either side lying. What
     * *would* prove misconduct is two independently-verified commits at
     * the same `rev` with different content; this function stops at "the
     * bytes disagree" because it does not parse CAR, and hands the
     * decode-and-verify step to the client (Q-PMR-24). */
    | "equivocation"
    /** Differing `signingKey`. The DID document moved between the two
     * observations — a question for the PLC log, not for these records,
     * and for `did:web` not even that: there is no log, so a rotation
     * there cannot be adjudicated at all (`spec/trust-model.md`). */
    | "rotated"
    /** Same authority, same rev, same bytes, different `source`. Not an
     * alarm — a mirror or a migration in flight — but worth surfacing
     * separately from `agree`, since a reader may still want to know the
     * two monitors are not reading the same host. Note this is checked
     * *after* content equality: two different hosts serving the same rev
     * with differing bytes lands in `equivocation` above, not here, even
     * though a benign serialization difference between two honest hosts
     * would look identical from this function's point of view. */
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
 * compare it against, not that it is ruled out), so comparison falls
 * through to `rev`/content as if the key had never been checked at all.
 * That fallback is sound whenever it disagrees — `equivocation`/`skew`
 * still hold regardless of which authority was in effect — but it has one
 * real blind spot: a genuine rotation whose two observations happen to
 * carry identical `rev` and identical bytes (content is independent of
 * which key signed it) reports `agree` if either side's key resolution
 * failed, exactly as it would with no rotation at all. Narrow, but real:
 * this function cannot see a rotation it has no key to compare.
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
