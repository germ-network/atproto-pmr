import { DurableObject } from "cloudflare:workers"
import {
    decodeEvent,
    intake,
    listReposByCollection,
    fetchHeadRev,
    pushDeclarationChange,
    refreshDue,
    sealDueWindows,
    settleDue,
    sweepBackfill,
    windowOf,
    type BackfillProgress,
    type Cursor,
    type DidDocumentSink,
    type FetchedRecord,
    type IngestDeps,
    type IntakeOutcome,
    type MonitorIndex,
    type PendingFetch,
    type PlcCursorIndex,
    type RefreshIndex,
} from "@germ-network/atproto-pmr-monitor"
import type { DidDocument } from "@germ-network/atproto-pmr-core"
import { canonicalDidDocumentJson } from "./did-document-store"
import type { MonitorEnv } from "./env"
import { monitorWebPushSender } from "./push-sender"
import { kvMonitorRegistrationStore } from "./registration-store"
import { kvSnapshotStore } from "./snapshot-store"

/**
 * Bound on the Jetstream WebSocket upgrade, matching the fetch guards in
 * `@germ-network/atproto-pmr-core`'s `atproto-fetch.ts` (also 5s) — this
 * runs on the same single-threaded object those calls run alongside,
 * outside `connect`, so an unbounded network call here is exactly the
 * same hazard.
 */
const CONNECT_TIMEOUT_MS = 5_000

/**
 * Whether `armWatchdog` should replace the stored alarm: absent, OR
 * already due. The second case is not hypothetical — observed in
 * production, a due alarm that for whatever reason was never dispatched
 * left `getAlarm()` permanently non-null, so the old "only if absent"
 * check silently declined to fix it: the object kept answering `start()`
 * successfully every poke while nothing was ever sealed or fetched again,
 * because nothing ever replaced the stuck value. An overdue alarm is
 * exactly as useless as no alarm; re-arming it is strictly an
 * improvement, never a regression, since the platform's own guarantee to
 * eventually deliver a pending alarm is not something this object can
 * verify from the inside — waiting on it is a bet this object cannot
 * afford to lose silently.
 *
 * A plain function, not inlined into `armWatchdog`, because the local
 * dev runtime clears an overdue alarm back to `null` near-instantly —
 * unlike the production incident this fixes, where it stayed non-null
 * for hours — so the "already due" branch is only exercisable as a unit
 * test against real numbers, not through the real storage in this repo's
 * test harness.
 */
export function needsRearm(existingAlarmAt: number | null, nowMs: number): boolean {
    return existingAlarmAt === null || existingAlarmAt <= nowMs
}

/**
 * The monitor's single writer: it holds the stream, and it is the only
 * thing that advances the cursor or the `rev` index.
 *
 * **A singleton.** Address it by a fixed name. A relay's objects are per
 * registration; this one is per *network*, because there is one stream and
 * one cursor into it.
 *
 * An outbound WebSocket does not hibernate — the Hibernation API covers
 * incoming sockets — so this object stays resident while connected and is
 * evicted on the platform's schedule regardless. That is designed for
 * rather than fought: the alarm reconnects from the stored cursor, and
 * because the cursor is what guarantees coverage, an eviction is
 * indistinguishable from any other gap.
 *
 * Subclass to supply the authoritative fetch, which is deliberately not
 * implemented here: resolving a DID document and reading from that DID's
 * own PDS is a policy decision (which resolver, which timeouts, whether to
 * verify the CAR proof) that belongs to a deployment, not to a storage
 * adapter.
 */
export class MonitorIngest
    extends DurableObject<MonitorEnv>
    implements MonitorIndex, RefreshIndex, DidDocumentSink, PlcCursorIndex
{
    private readonly db: DurableObjectStorage
    private socket: WebSocket | null = null

    constructor(ctx: DurableObjectState, env: MonitorEnv) {
        super(ctx, env)
        this.db = ctx.storage
        ctx.blockConcurrencyWhile(async () => {
            this.db.sql.exec(`
                CREATE TABLE IF NOT EXISTS revs (
                    did TEXT PRIMARY KEY,
                    rev TEXT NOT NULL,
                    observed_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pending (
                    did TEXT PRIMARY KEY,
                    rev TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    not_before INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS window_members (
                    window INTEGER NOT NULL,
                    did TEXT NOT NULL,
                    PRIMARY KEY (window, did)
                );
                CREATE TABLE IF NOT EXISTS deleted (
                    did TEXT PRIMARY KEY,
                    deleted_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS checks (
                    did TEXT PRIMARY KEY,
                    checked_at INTEGER NOT NULL,
                    attempted_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS did_documents (
                    did TEXT PRIMARY KEY,
                    document TEXT NOT NULL,
                    as_of INTEGER NOT NULL,
                    confirmed_at INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    published_version INTEGER,
                    published_confirmed_at INTEGER
                );
            `)
        })
    }

    // ---- Stored DID documents ---------------------------------------------

    /**
     * Ordered by `asOfMs` (see `DidDocumentSink`). A write equal in content
     * (`canonicalDidDocumentJson`) to the stored one only advances its
     * confirmation time; a different one bumps the row's version, and so
     * does any write onto a stale-marked or placeholder row (confirmation 0),
     * because the published entry was removed and must be put again. A
     * confirmation of 0 therefore means "not trusted". The read,
     * compare and write run with no await between them. SQLite only;
     * `publishDidDocuments` carries it to KV.
     */
    async recordDidDocument(
        did: string,
        document: DidDocument | null,
        asOfMs: number
    ): Promise<void> {
        const json = canonicalDidDocumentJson(document)
        const row = this.didDocumentRow(did)
        if (row === undefined) {
            this.db.sql.exec(
                "INSERT INTO did_documents (did, document, as_of, confirmed_at, version) " +
                    "VALUES (?, ?, ?, ?, 1)",
                did,
                json,
                asOfMs,
                asOfMs
            )
            return
        }
        if (asOfMs < row.as_of) return
        // Content restored after a stale mark is a change to readers: the
        // published entry was removed, so it must be put again.
        const changed = json !== row.document || row.confirmed_at === 0
        this.db.sql.exec(
            "UPDATE did_documents SET document = ?, as_of = ?, confirmed_at = ?, " +
                "version = version + ? WHERE did = ?",
            json,
            asOfMs,
            asOfMs,
            changed ? 1 : 0,
            did
        )
    }

    private didDocumentRow(
        did: string
    ): { document: string; as_of: number; confirmed_at: number } | undefined {
        return this.db.sql
            .exec<{ document: string; as_of: number; confirmed_at: number }>(
                "SELECT document, as_of, confirmed_at FROM did_documents WHERE did = ?",
                did
            )
            .toArray()[0]
    }

    /**
     * Ordered like `recordDidDocument`. Bumps the version and zeroes the
     * confirmation, so the next publish removes `doc:<did>` and every reader
     * falls back to the directory; a later write restores it. With no row
     * yet, inserts an untrusted placeholder (document `""`, distinct from
     * `"null"` = gone) at `asOfMs`, so a fetch that started before the change
     * cannot land the superseded document as the first row.
     */
    async markDidDocumentStale(did: string, asOfMs: number): Promise<void> {
        const row = this.didDocumentRow(did)
        if (row === undefined) {
            this.db.sql.exec(
                "INSERT INTO did_documents (did, document, as_of, confirmed_at, version) " +
                    "VALUES (?, '', ?, 0, 1)",
                did,
                asOfMs
            )
            return
        }
        if (asOfMs < row.as_of) return
        this.db.sql.exec(
            "UPDATE did_documents SET as_of = ?, confirmed_at = 0, version = version + 1 " +
                "WHERE did = ?",
            asOfMs,
            did
        )
    }

    /**
     * Publish up to `limit` stored documents to KV, content changes first. A
     * trusted document is put as a `CachedDidDocument`; a tombstone, a stale
     * mark or a placeholder removes `doc:<did>` instead, so readers ask the
     * directory. Rows selected:
     * any whose version differs from the published one; then any confirmed
     * at least half of `STORED_DID_DOCUMENT_MAX_AGE_MS` after what KV holds
     * (so an unchanged document costs at most two KV writes a day); then any
     * whose KV confirmation predates the stream's current unbroken run while
     * its stored one does not. Marks published the version and confirmation
     * it put, not whatever the row holds by then. A KV failure leaves the row
     * for the next call. Resolves `{published, remaining, coveredThroughMs}`:
     * `remaining` counts content changes (staleness included) unpublished
     * after the last put; `coveredThroughMs` is the high-water `createdAt`
     * taken before any row was selected, or null when the pass is not drained
     * or no run has begun — so a change that lands mid-pass is never counted
     * as covered.
     */
    async publishDidDocuments(
        limit: number
    ): Promise<{ published: number; remaining: number; coveredThroughMs: number | null }> {
        void limit
        throw new Error("not implemented")
    }

    /**
     * Publish `plc:coverage`, advancing `coveredThroughMs` to the given value
     * (from a drained `publishDidDocuments`) or re-publishing the previous
     * one when null. Called only after the cursor row holding the run's
     * `continuousSinceMs` is persisted; a no-op until a run has been
     * persisted, so KV never claims a run an eviction could lose.
     */
    async publishPlcCoverage(coveredThroughMs: number | null): Promise<void> {
        void coveredThroughMs
        throw new Error("not implemented")
    }

    // ---- PLC export cursor ------------------------------------------------

    async isWatched(did: string): Promise<boolean> {
        void did
        throw new Error("not implemented")
    }

    /**
     * In memory; persisted at most every 5 s (checked on the next frame, not
     * by a timer) and on every alarm. Losing the unpersisted tail only replays.
     */
    async advancePlcCursor(seq: number, createdAtMs: number): Promise<void> {
        void seq
        void createdAtMs
        throw new Error("not implemented")
    }

    /** The stored seq, or null when none is stored for `url`. */
    async readPlcCursor(url: string): Promise<number | null> {
        void url
        throw new Error("not implemented")
    }

    /**
     * Clears the stored row and the in-memory high-water seq together, and
     * ends the unbroken run: the next frame's `createdAt` starts a new one.
     */
    async resetPlcCursor(): Promise<void> {
        throw new Error("not implemented")
    }

    /**
     * The second outbound socket, to `PLC_EXPORT_STREAM_URL`, resuming after
     * the stored seq, or from the tip (starting a new unbroken run) when there
     * is none for this URL. Same bounded upgrade as `connect`. Frames are
     * handled strictly in order on one promise chain. A no-op when the
     * variable is unset or the socket is open.
     */
    async connectPlc(): Promise<void> {
        throw new Error("not implemented")
    }

    // ---- MonitorIndex -----------------------------------------------------

    async readCursor(): Promise<Cursor | null> {
        const row = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'cursor'")
            .toArray()[0]
        return row?.v ?? null
    }

    /**
     * Dedupe, owe the fetch, and advance the cursor — one statement batch,
     * so the object's serialized execution makes it atomic.
     *
     * Both halves together or neither: a cursor that advanced without the
     * obligation would skip the event on the next resume, and an
     * obligation without the cursor would replay forever. The `duplicate`
     * arm is what makes a reconnect affordable, since resume rewinds to a
     * segment boundary and most of what arrives has already been applied.
     */
    async intake(
        event: { did: string; rev: string },
        cursor: Cursor
    ): Promise<IntakeOutcome> {
        const known = this.db.sql
            .exec<{ rev: string }>("SELECT rev FROM revs WHERE did = ?", event.did)
            .toArray()[0]
        if (known?.rev === event.rev) {
            // Still advance: this event is accounted for.
            this.db.sql.exec(
                "INSERT INTO meta (k, v) VALUES ('cursor', ?) " +
                    "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                cursor
            )
            return { outcome: "duplicate" }
        }
        this.db.sql.exec(
            "INSERT INTO pending (did, rev, attempts, not_before) VALUES (?, ?, 0, 0) " +
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev",
            event.did,
            event.rev
        )
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('cursor', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            cursor
        )
        return { outcome: "accepted" }
    }

    /** Owe a fetch the dedupe check would otherwise suppress. */
    async owe(did: string, rev: string): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO pending (did, rev, attempts, not_before) VALUES (?, ?, 0, 0) " +
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev",
            did,
            rev
        )
    }

    /** Discharge an obligation without indexing: a terminal, unstorable answer. */
    async clearPending(did: string): Promise<void> {
        this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
    }

    /**
     * Index the rev, add the DID to the open digest window, and clear the
     * obligation — after the bytes are durable, and in one batch so the
     * object's serialized execution makes it atomic.
     *
     * The window is chosen by **observation time**, `observedAtMs`, not by
     * when the change happened: a sealed filter cannot be amended, and the
     * retry path settles arbitrarily late.
     *
     * Also drops any `deleted` mark for `did` — reaching here at all means
     * the ordinary commit path just fetched and stored a live record for
     * it, so a prior deletion no longer holds.
     */
    async complete(did: string, rev: string, observedAtMs: number): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO revs (did, rev, observed_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev, observed_at = excluded.observed_at",
            did,
            rev,
            observedAtMs
        )
        this.db.sql.exec(
            "INSERT INTO window_members (window, did) VALUES (?, ?) " +
                "ON CONFLICT(window, did) DO NOTHING",
            windowOf(observedAtMs, this.digestWidthMs()),
            did
        )
        this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
        this.db.sql.exec("DELETE FROM deleted WHERE did = ?", did)
    }

    /**
     * Deletion's counterpart to `complete`: add `did` to the open digest
     * window the same way a stored change would, and discharge the
     * pending row — one batch, same atomicity argument. Deliberately
     * leaves `revs` untouched; see `MonitorIndex.completeDeletion`.
     *
     * `permanent` gates only the `deleted` row — see that method's own
     * doc for why a reversible state must NOT mark `did` `isDeleted`.
     */
    async completeDeletion(
        did: string,
        observedAtMs: number,
        permanent: boolean
    ): Promise<void> {
        if (permanent) {
            this.db.sql.exec(
                "INSERT INTO deleted (did, deleted_at) VALUES (?, ?) " +
                    "ON CONFLICT(did) DO UPDATE SET deleted_at = excluded.deleted_at",
                did,
                observedAtMs
            )
        }
        this.db.sql.exec(
            "INSERT INTO window_members (window, did) VALUES (?, ?) " +
                "ON CONFLICT(window, did) DO NOTHING",
            windowOf(observedAtMs, this.digestWidthMs()),
            did
        )
        this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
    }

    async isDeleted(did: string): Promise<boolean> {
        const row = this.db.sql
            .exec<{ did: string }>("SELECT did FROM deleted WHERE did = ?", did)
            .toArray()[0]
        return row !== undefined
    }

    private digestWidthMs(): number {
        return this.envInt(this.env.DIGEST_WINDOW_MS, 600_000)
    }

    private envInt(raw: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(raw ?? "", 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }

    async windowMembers(window: number): Promise<string[]> {
        return this.db.sql
            .exec<{ did: string }>(
                "SELECT did FROM window_members WHERE window = ? ORDER BY did",
                window
            )
            .toArray()
            .map((r) => r.did)
    }

    async dropWindow(window: number): Promise<void> {
        this.db.sql.exec("DELETE FROM window_members WHERE window = ?", window)
    }

    async readBackfillProgress(): Promise<BackfillProgress> {
        const row = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'backfill'")
            .toArray()[0]
        // Absent means never started, same as an explicit `{done: false,
        // cursor: null}` would — the meta table just has nothing to say yet.
        if (row === undefined) return { done: false, cursor: null }
        return JSON.parse(row.v) as BackfillProgress
    }

    async setBackfillProgress(progress: BackfillProgress): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('backfill', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            JSON.stringify(progress)
        )
    }

    async duePending(nowMs: number, limit: number): Promise<PendingFetch[]> {
        return this.db.sql
            .exec<{ did: string; rev: string; attempts: number; not_before: number }>(
                "SELECT did, rev, attempts, not_before FROM pending " +
                    "WHERE not_before <= ? ORDER BY not_before LIMIT ?",
                nowMs,
                limit
            )
            .toArray()
            .map((r) => ({
                did: r.did,
                rev: r.rev,
                attempts: r.attempts,
                notBeforeMs: r.not_before,
            }))
    }

    async deferPending(did: string, notBeforeMs: number): Promise<void> {
        this.db.sql.exec(
            "UPDATE pending SET attempts = attempts + 1, not_before = ? WHERE did = ?",
            notBeforeMs,
            did
        )
    }

    async revOf(did: string): Promise<string | null> {
        const row = this.db.sql
            .exec<{ rev: string }>("SELECT rev FROM revs WHERE did = ?", did)
            .toArray()[0]
        return row?.rev ?? null
    }

    // ---- RefreshIndex -----------------------------------------------------

    /**
     * Held DIDs not confirmed since `checkedBeforeMs`. A DID counts as
     * confirmed at its last check or, if never checked, when it was last
     * stored. Ordered by the later of that and its last failed attempt, so a
     * DID whose source keeps failing queues behind the healthy ones instead
     * of occupying the head of every batch. A separate table from `revs` so
     * recording a check needs no schema change there.
     */
    async dueRefresh(checkedBeforeMs: number, limit: number): Promise<string[]> {
        return this.db.sql
            .exec<{ did: string }>(
                "SELECT r.did AS did, " +
                    "MAX(r.observed_at, COALESCE(c.checked_at, 0)) AS confirmed, " +
                    "MAX(r.observed_at, COALESCE(c.checked_at, 0), COALESCE(c.attempted_at, 0)) AS last " +
                    "FROM revs r LEFT JOIN checks c ON c.did = r.did " +
                    "WHERE r.did NOT IN (SELECT did FROM deleted) " +
                    "AND r.did NOT IN (SELECT did FROM pending) " +
                    "AND confirmed < ? " +
                    "ORDER BY last ASC LIMIT ?",
                checkedBeforeMs,
                limit
            )
            .toArray()
            .map((r) => r.did)
    }

    async markChecked(did: string, checkedAtMs: number): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO checks (did, checked_at) VALUES (?, ?) " +
                "ON CONFLICT(did) DO UPDATE SET checked_at = excluded.checked_at",
            did,
            checkedAtMs
        )
    }

    async markAttempted(did: string, attemptedAtMs: number): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO checks (did, checked_at, attempted_at) VALUES (?, 0, ?) " +
                "ON CONFLICT(did) DO UPDATE SET attempted_at = excluded.attempted_at",
            did,
            attemptedAtMs
        )
    }

    /**
     * Advance the rev for a snapshot whose declaration record did not
     * change: no digest-window entry, because nothing a client holds became
     * stale.
     */
    async completeQuietly(did: string, rev: string, observedAtMs: number): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO revs (did, rev, observed_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev, observed_at = excluded.observed_at",
            did,
            rev,
            observedAtMs
        )
    }

    // ---- ingest -----------------------------------------------------------

    /**
     * The authoritative read, tier 2: `com.atproto.sync.getRecord` at the
     * DID's own PDS. Unimplemented here on purpose — see the class comment.
     */
    protected fetchRecord(_did: string): Promise<FetchedRecord> {
        throw new Error(
            "MonitorIngest.fetchRecord is deployment-supplied: subclass and implement it"
        )
    }

    /**
     * The head `rev` of the DID's repo at its PDS, for the refresh. Defaults
     * to a real read; a subclass overrides it alongside `fetchRecord` when
     * the deployment resolves DIDs differently.
     */
    protected fetchHeadRev(did: string): Promise<string> {
        return fetchHeadRev(did)
    }

    /**
     * Own-DID push, where a registration holds this DID. The default here
     * is a real implementation, not a stub to override: any deployment
     * that binds `registrations` and the push vars (`env.ts`) gets working
     * own-DID push for free, which is what keeps a deployment subclass
     * (e.g. `GermMonitor`) from needing to know anything about push at
     * all — it only supplies the authoritative fetch.
     */
    protected onChange(did: string, _rev: string): Promise<void> {
        this.notifyRegistration(did)
        return Promise.resolve()
    }

    /**
     * A rev that moved backwards. Never silent in a real deployment — and,
     * like `onChange`, pushes to a registered device: a regression is
     * exactly the kind of change `spec/key-transparency.md`'s "own-DID
     * push on any change" means to cover, arguably more urgently than an
     * ordinary advance.
     */
    protected onRegression(did: string, indexed: string, observed: string): Promise<void> {
        console.log("monitor: rev regression", { did, indexed, observed })
        this.notifyRegistration(did)
        return Promise.resolve()
    }

    /**
     * The watched declaration was confirmed deleted at the source. Pushes
     * to a registered device the same as `onChange`/`onRegression` — the
     * device re-fetches, finds nothing, and reacts accordingly; this
     * object never asserts what the change was, only that one happened.
     */
    protected onDelete(did: string): Promise<void> {
        console.log("monitor: declaration deleted", { did })
        this.notifyRegistration(did)
        return Promise.resolve()
    }

    /**
     * Fire-and-forget: kicks off `deliverDeclarationPush` and hands it to
     * `ctx.waitUntil` without awaiting it here, so it runs deferred from
     * `settle()`'s own completion — exactly as `packages/cloudflare`'s
     * `pmr-object.ts` defers its push. Split from `deliverDeclarationPush`
     * itself (rather than inlined) so a test can invoke the real work
     * directly and await it, the same way `push.spec.ts` tests
     * `PMRObject.deliverPush` directly rather than through its own
     * deferred call sites — asserting on the result of something wrapped
     * in `waitUntil` is a race by construction, not a fixture problem.
     */
    private notifyRegistration(did: string): void {
        this.ctx.waitUntil(this.deliverDeclarationPush(did))
    }

    /**
     * The actual own-DID push: compose the sender, load the registration,
     * send, and drop the registration on `discard`. Never throws — a push
     * failure must not propagate back into `settle()`, whose caller
     * (`settleDue`) treats any throw as a transient fetch failure and
     * re-schedules the PDS read. That would be wrong here: the record
     * already settled correctly, and only the notification failed. So
     * every failure — a thrown error, or a `"failed"` delivery outcome
     * (e.g. a rotated VAPID key that no longer pairs) — is caught and
     * logged here, using only the subscription endpoint's origin, never
     * the full capability URL. `"discard"`/`"retry"`/`"delivered"` are
     * expected lifecycle, not failures, and stay unlogged — matching the
     * PMR's own `deliverPush` (`pmr-object.ts`), including why a `"failed"`
     * outcome needs its own explicit check: `pushDeclarationChange` cannot
     * throw one, so nothing here would ever see it without checking.
     *
     * The whole body is guarded, not just the send: `monitorWebPushSender`
     * decodes `VAPID_PRIVATE_KEY` eagerly, so a malformed secret throws
     * right there, before any request is attempted — the same
     * base-wide-misconfiguration class the PMR's own `deliverPush` guards
     * against for the same reason.
     */
    private async deliverDeclarationPush(did: string): Promise<void> {
        try {
            const registrations = kvMonitorRegistrationStore(this.env)
            const sender = monitorWebPushSender(this.env)
            if (registrations === null || sender === null) return

            const result = await pushDeclarationChange(did, { registrations, sender })
            if (result?.outcome === "failed") {
                console.error(
                    `monitor onChange: push service answered ${result.status} for ${did}`
                )
            }
        } catch (err) {
            console.error(`monitor onChange: push failed for ${did}:`, err)
        }
    }

    private deps(): IngestDeps {
        return {
            index: this,
            snapshot: kvSnapshotStore(this.env),
            fetchRecord: (did) => this.fetchRecord(did),
            onChange: (did, rev) => this.onChange(did, rev),
            onRegression: (did, i, o) => this.onRegression(did, i, o),
            onDelete: (did) => this.onDelete(did),
            nowMs: () => Date.now(),
        }
    }

    /**
     * The way in. Idempotent, and the only thing that needs calling from
     * outside: a scheduled Worker pokes it, and everything after is the
     * object's own alarm chain.
     *
     * Without this the object had no entry point at all — `connect` armed
     * the alarm and only the alarm called `connect`, so a freshly deployed
     * monitor would have sat inert forever.
     */
    async start(): Promise<void> {
        await this.armWatchdog()
        if (this.socket === null) await this.connect()
    }

    /**
     * Open the stream at the stored cursor, or at the tip on first run.
     *
     * The upgrade fetch is bounded, unlike a plain request: this runs
     * inside `alarm()`, which is single-threaded with every other call
     * into this object. An upstream that accepts the connection and never
     * completes the handshake would otherwise wedge the object forever,
     * with no self-heal, since the watchdog that is supposed to recover
     * from exactly that is the thing stuck. Observed in production before
     * the digest read path moved off this object entirely: Jetstream
     * stopped answering, and every route that RPC'd in here hung
     * indefinitely while plain KV reads stayed fast — this object was
     * blocked here, never reaching `alarm`'s `finally` to reschedule
     * itself. No request handler reaches this object anymore, so a wedge
     * here now only delays ingest, never a read.
     */
    async connect(): Promise<void> {
        if (this.socket !== null) return
        const cursor = await this.readCursor()
        const url = new URL(this.env.JETSTREAM_URL)
        url.searchParams.set("collections", this.env.MONITOR_COLLECTION)
        if (cursor !== null) url.searchParams.set("cursor", cursor)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
        let response: Response
        try {
            response = await fetch(url, {
                headers: { Upgrade: "websocket" },
                signal: controller.signal,
            })
        } finally {
            clearTimeout(timer)
        }
        const ws = response.webSocket
        if (ws === null) throw new Error("jetstream did not upgrade")
        ws.accept()
        this.socket = ws

        ws.addEventListener("message", (event) => {
            void this.onFrame(String(event.data))
        })
        const drop = () => {
            this.socket = null
        }
        ws.addEventListener("close", drop)
        ws.addEventListener("error", drop)
        await this.armWatchdog()
    }

    /**
     * The read loop: cheap by construction. A slow PDS awaited here would
     * back-pressure the stream, so nothing is fetched on this path — the
     * obligation is recorded and settled off the loop.
     */
    private async onFrame(raw: string): Promise<void> {
        const event = decodeEvent(raw)
        if (event === null) return
        // A frame without a parseable time still carries a DID worth
        // looking at; only the cursor is unknown, so hold the last one
        // rather than discard the event. Replaying a little on resume is
        // the cheap failure; dropping a key change is not.
        const cursor =
            event.timeMs === null
                ? await this.readCursor()
                : String(Math.round(event.timeMs * 1000))
        await intake(
            this.deps(),
            { collection: this.env.MONITOR_COLLECTION },
            event,
            cursor ?? ""
        )
    }

    protected async armWatchdog(): Promise<void> {
        const interval = Number.parseInt(this.env.WATCHDOG_INTERVAL_MS, 10)
        if (!Number.isFinite(interval) || interval <= 0) return
        const existing = await this.db.getAlarm()
        if (needsRearm(existing, Date.now())) {
            await this.db.setAlarm(Date.now() + interval)
        }
    }

    /**
     * Watchdog, backfill, and retry queue. Reconnects a dropped stream,
     * discovers anything the live tail could never see on its own, then
     * settles what is owed — the only thing standing between a PDS outage
     * and a silently dropped DID, since the stream will not redeliver.
     */
    async alarm(): Promise<void> {
        try {
            if (this.socket === null) await this.connect()
        } finally {
            // Before settling, so a DID this sweep just discovered is
            // eligible for the same tick's settle pass rather than
            // waiting a full watchdog interval — `SETTLE_BATCH` still
            // caps how much of it actually gets fetched this tick either
            // way, so a large page cannot turn into an unbounded fetch
            // burst.
            await sweepBackfill({
                index: this,
                listRepos: (cursor) =>
                    listReposByCollection(cursor, {
                        relayUrl: this.env.BACKFILL_RELAY_URL,
                        collection: this.env.MONITOR_COLLECTION,
                        limit: this.envInt(this.env.BACKFILL_BATCH, 100),
                    }),
            })
            const batch = Number.parseInt(this.env.SETTLE_BATCH, 10)
            await settleDue(this.deps(), Number.isFinite(batch) ? batch : 32)
            // After settling (a just-stored snapshot is not yet due) and
            // before sealing (a change it finds lands in a window that has
            // not closed).
            try {
                const refreshed = await refreshDue(
                    {
                        ingest: this.deps(),
                        refreshIndex: this,
                        refreshSnapshots: kvSnapshotStore(this.env),
                        fetchHeadRev: (did) => this.fetchHeadRev(did),
                        collection: this.env.MONITOR_COLLECTION,
                        rkey: "self",
                    },
                    {
                        nowMs: Date.now(),
                        staleAfterMs: this.envInt(this.env.REFRESH_STALE_AFTER_MS, 3_600_000),
                        limit: this.envInt(this.env.REFRESH_BATCH, 64),
                    }
                )
                console.log("monitor: refresh", refreshed)
            } catch (err) {
                // The alarm must still seal and re-arm itself.
                console.error("monitor: refresh failed", err)
            }
            // Sealed after settling, so anything confirmed on this wake
            // lands in a window before that window is closed out.
            await sealDueWindows({
                index: this,
                snapshot: kvSnapshotStore(this.env),
                widthMs: this.digestWidthMs(),
                retentionMs:
                    this.envInt(this.env.WINDOW_RETENTION_SECONDS, 604_800) * 1000,
                nowMs: () => Date.now(),
            })
            const interval = Number.parseInt(this.env.WATCHDOG_INTERVAL_MS, 10)
            if (Number.isFinite(interval) && interval > 0) {
                await this.db.setAlarm(Date.now() + interval)
            }
        }
    }
}
