import { DurableObject } from "cloudflare:workers"
import {
    decodeEvent,
    decodePlcExportFrame,
    drainKeyUpdates,
    intake,
    intakePlcEvent,
    listReposByCollection,
    plcCursorAfterClose,
    fetchHeadRev,
    pushDeclarationChange,
    refreshDue,
    sealDueWindows,
    settleDue,
    sweepBackfill,
    windowOf,
    type BackfillProgress,
    type Cursor,
    type FetchedRecord,
    type IngestDeps,
    type IntakeOutcome,
    type KeyUpdateIndex,
    type MonitorIndex,
    type OwedKeyUpdate,
    type PendingFetch,
    type RefreshIndex,
    type SigningKeyUpdate,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import { monitorWebPushSender } from "./push-sender"
import { kvMonitorRegistrationStore } from "./registration-store"
import { kvSigningKeyCache } from "./signing-key-store"
import { kvSnapshotStore } from "./snapshot-store"

/**
 * Bound on the Jetstream WebSocket upgrade, matching the fetch guards in
 * `@germ-network/atproto-pmr-core`'s `atproto-fetch.ts` (also 5s) — this
 * runs on the same single-threaded object those calls run alongside,
 * outside `connect`, so an unbounded network call here is exactly the
 * same hazard.
 */
const CONNECT_TIMEOUT_MS = 5_000

/** Owed key updates applied per drain. */
const KEY_DRAIN_BATCH = 64

/**
 * Longest the PLC cursor goes unpersisted while the stream runs. A lost
 * tail only replays ops, which is idempotent; persisting per frame would
 * cost a write for every op the directory accepts.
 */
const PLC_CURSOR_PERSIST_MS = 5_000

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
 * one cursor into it. With `PLC_EXPORT_STREAM_URL` set it also holds the
 * PLC directory's export stream, with its own cursor.
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
    implements MonitorIndex, RefreshIndex, KeyUpdateIndex
{
    private readonly db: DurableObjectStorage
    private socket: WebSocket | null = null
    private plcSocket: WebSocket | null = null
    /**
     * The highest export `seq` seen, shared by every path that advances the
     * PLC cursor so a lazy flush can never write an older value over a
     * newer one. Cleared with the stored row on reset.
     */
    private plcSeq: number | null = null
    private plcPersistedAt = 0
    private draining: Promise<void> | null = null
    private drainAgain = false

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
                CREATE TABLE IF NOT EXISTS key_updates (
                    did TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    key TEXT,
                    as_of INTEGER,
                    version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS checks (
                    did TEXT PRIMARY KEY,
                    checked_at INTEGER NOT NULL,
                    attempted_at INTEGER NOT NULL DEFAULT 0
                );
            `)
        })
    }

    // ---- KeyUpdateIndex ---------------------------------------------------

    /**
     * The cursor is per directory host, so one stored for a different
     * `PLC_EXPORT_STREAM_URL` reads as none.
     */
    async readPlcCursor(): Promise<number | null> {
        if (this.plcSeq !== null) return this.plcSeq
        const row = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
            .toArray()[0]
        if (row === undefined) return null
        try {
            const stored = JSON.parse(row.v) as { url?: unknown; seq?: unknown }
            if (stored.url !== this.plcUrl() || typeof stored.seq !== "number") return null
            this.plcSeq = stored.seq
            return stored.seq
        } catch {
            return null
        }
    }

    async advancePlcCursor(seq: number): Promise<void> {
        await this.readPlcCursor()
        this.raisePlcSeq(seq)
        if (Date.now() - this.plcPersistedAt >= PLC_CURSOR_PERSIST_MS) this.persistPlcCursor()
    }

    async resetPlcCursor(): Promise<void> {
        this.plcSeq = null
        this.db.sql.exec("DELETE FROM meta WHERE k = 'plc_cursor'")
    }

    async isWatched(did: string): Promise<boolean> {
        const row = this.db.sql
            .exec<{ n: number }>(
                "SELECT 1 AS n WHERE (EXISTS (SELECT 1 FROM revs WHERE did = ?1) " +
                    "OR EXISTS (SELECT 1 FROM pending WHERE did = ?1)) " +
                    "AND NOT EXISTS (SELECT 1 FROM deleted WHERE did = ?1)",
                did
            )
            .toArray()[0]
        return row !== undefined
    }

    /** Replaces any update already owed for `did`, and bumps its version. */
    async oweKeyUpdate(did: string, update: SigningKeyUpdate, plcSeq?: number): Promise<void> {
        // Load the stored cursor first so the max below cannot start from nothing.
        if (plcSeq !== undefined) await this.readPlcCursor()
        this.db.sql.exec(
            "INSERT INTO key_updates (did, kind, key, as_of, version) VALUES (?, ?, ?, ?, 1) " +
                "ON CONFLICT(did) DO UPDATE SET kind = excluded.kind, key = excluded.key, " +
                "as_of = excluded.as_of, version = key_updates.version + 1",
            did,
            update.kind,
            update.kind === "put" ? update.key : null,
            update.kind === "put" ? update.asOfMs : null
        )
        if (plcSeq !== undefined) {
            this.raisePlcSeq(plcSeq)
            this.persistPlcCursor()
        }
    }

    async dueKeyUpdates(limit: number): Promise<OwedKeyUpdate[]> {
        return this.db.sql
            .exec<{
                did: string
                kind: string
                key: string | null
                as_of: number | null
                version: number
            }>(
                "SELECT did, kind, key, as_of, version FROM key_updates ORDER BY rowid LIMIT ?",
                limit
            )
            .toArray()
            .map((r) => ({
                did: r.did,
                version: r.version,
                update:
                    r.kind === "put" && r.as_of !== null
                        ? { kind: "put" as const, key: r.key, asOfMs: r.as_of }
                        : { kind: "delete" as const },
            }))
    }

    async clearKeyUpdate(did: string, version: number): Promise<void> {
        this.db.sql.exec("DELETE FROM key_updates WHERE did = ? AND version = ?", did, version)
    }

    private plcUrl(): string | null {
        const url = this.env.PLC_EXPORT_STREAM_URL
        return url === undefined || url === "" ? null : url
    }

    private raisePlcSeq(seq: number): void {
        this.plcSeq = Math.max(this.plcSeq ?? seq, seq)
    }

    private persistPlcCursor(): void {
        if (this.plcSeq === null) return
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('plc_cursor', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            JSON.stringify({ url: this.plcUrl(), seq: this.plcSeq })
        )
        this.plcPersistedAt = Date.now()
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
            // The export stream is authoritative for did:plc, and a PDS's
            // identity event follows the directory's op, so once the stream
            // is consumed its hint would only clobber the fresh key.
            keyUpdates: {
                oweKeyUpdate: async (did, update, plcSeq) => {
                    if (this.plcUrl() !== null && did.startsWith("did:plc:")) return
                    await this.oweKeyUpdate(did, update, plcSeq)
                },
            },
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
        try {
            await this.connectPlc()
        } catch (err) {
            console.error("monitor: plc connect failed", err)
        }
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

        const ws = await this.upgrade(url, "jetstream")
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
     * Open the PLC directory's export stream at the stored `seq`, or at the
     * tip when there is none. A no-op unless `PLC_EXPORT_STREAM_URL` is set.
     * Bounded like `connect`, and reconnected only from the alarm.
     */
    async connectPlc(): Promise<void> {
        const base = this.plcUrl()
        if (base === null || this.plcSocket !== null) return
        const cursor = await this.readPlcCursor()
        const url = new URL(base)
        if (cursor !== null) url.searchParams.set("cursor", String(cursor))

        const ws = await this.upgrade(url, "plc export stream")
        this.plcSocket = ws

        ws.addEventListener("message", (event) => {
            void this.onPlcFrame(String(event.data))
        })
        ws.addEventListener("close", (event) => {
            if (this.plcSocket === ws) this.plcSocket = null
            if (plcCursorAfterClose(event.reason) === "reset") {
                void this.resetPlcCursor().catch((err) =>
                    console.error("monitor: plc cursor reset failed", err)
                )
            }
        })
        ws.addEventListener("error", () => {
            if (this.plcSocket === ws) this.plcSocket = null
        })
    }

    private async upgrade(url: URL, what: string): Promise<WebSocket> {
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
        if (ws === null) throw new Error(`${what} did not upgrade`)
        ws.accept()
        return ws
    }

    /**
     * The export stream's read loop: index lookups only, and the owed update
     * is applied off the loop. Never throws into the socket.
     */
    private async onPlcFrame(raw: string): Promise<void> {
        try {
            const event = decodePlcExportFrame(raw)
            if (event === null) return
            if ((await intakePlcEvent(this, event)) === "owed") this.kickDrain()
        } catch (err) {
            console.error("monitor: plc frame failed", err)
        }
    }

    private kickDrain(): void {
        void this.drainKeys()
    }

    /**
     * Apply owed key updates to the cache. Single-flight (a call during a
     * drain makes it run once more), and never throws:
     * a failure leaves the updates owed for the next alarm.
     */
    private drainKeys(): Promise<void> {
        if (this.draining !== null) {
            // Owed after the running drain read its batch: go again, rather
            // than leave it for the next alarm.
            this.drainAgain = true
            return this.draining
        }
        this.draining = (async () => {
            try {
                do {
                    this.drainAgain = false
                    await drainKeyUpdates(
                        { index: this, cache: kvSigningKeyCache(this.env), nowMs: () => Date.now() },
                        KEY_DRAIN_BATCH
                    )
                } while (this.drainAgain)
            } catch (err) {
                console.error("monitor: key drain failed", err)
            } finally {
                this.draining = null
            }
        })()
        return this.draining
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
        const decision = await intake(
            this.deps(),
            { collection: this.env.MONITOR_COLLECTION },
            event,
            cursor ?? ""
        )
        if (decision === "reverify") this.kickDrain()
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
            try {
                await this.connectPlc()
            } catch (err) {
                console.error("monitor: plc connect failed", err)
            }
            // Ahead of the sweep, which throws when its relay is down and
            // would otherwise strand owed key updates behind it.
            await this.drainKeys()
            this.persistPlcCursor()
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
