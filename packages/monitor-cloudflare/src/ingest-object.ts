import { DurableObject } from "cloudflare:workers"
import {
    decodeEvent,
    intake,
    sealDueWindows,
    serveDigest,
    settleDue,
    windowOf,
    type DigestPage,
    type Cursor,
    type DeltaCursor,
    type FetchedRecord,
    type IngestDeps,
    type IntakeOutcome,
    type MonitorIndex,
    type PendingFetch,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import { kvSnapshotStore } from "./snapshot-store"

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
export class MonitorIngest extends DurableObject<MonitorEnv> implements MonitorIndex {
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
            `)
        })
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
    }

    private digestWidthMs(): number {
        return this.envInt(this.env.DIGEST_WINDOW_MS, 600_000)
    }

    private envInt(raw: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(raw ?? "", 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }

    /** Serve a digest page. Read-only, so a Worker may call it directly. */
    async digestPage(from: number): Promise<DigestPage> {
        return serveDigest(
            {
                index: this,
                snapshot: kvSnapshotStore(this.env),
                widthMs: this.digestWidthMs(),
                byteBudget: this.envInt(this.env.DIGEST_BYTE_BUDGET, 65_536),
                retentionMs:
                    this.envInt(this.env.WINDOW_RETENTION_SECONDS, 604_800) * 1000,
                nowMs: () => Date.now(),
            },
            from
        )
    }

    async closedWindowsWithMembers(
        currentWindow: number,
        limit: number
    ): Promise<number[]> {
        return this.db.sql
            .exec<{ window: number }>(
                "SELECT DISTINCT window FROM window_members WHERE window < ? " +
                    "ORDER BY window LIMIT ?",
                currentWindow,
                limit
            )
            .toArray()
            .map((r) => r.window)
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

    async readSealedThrough(): Promise<number | null> {
        const row = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'sealed_through'")
            .toArray()[0]
        if (row === undefined) return null
        const parsed = Number(row.v)
        return Number.isFinite(parsed) ? parsed : null
    }

    async setSealedThrough(window: number): Promise<void> {
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('sealed_through', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            String(window)
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

    /**
     * Compared in **this monitor's observation clock**, never against the
     * stream cursor: those are different quantities in different units,
     * and comparing them answers "nothing changed" forever rather than
     * failing. The cursor handed back is drawn from the same clock.
     */
    async changedSince(
        dids: readonly string[],
        since: DeltaCursor | null
    ): Promise<{ dids: string[]; nextCursor: DeltaCursor }> {
        const now = Date.now()
        if (dids.length === 0) return { dids: [], nextCursor: String(now) }
        const parsed = since === null ? 0 : Number(since)
        const bound = Number.isFinite(parsed) ? parsed : 0
        const holes = dids.map(() => "?").join(",")
        const changed = this.db.sql
            .exec<{ did: string }>(
                `SELECT did FROM revs WHERE observed_at > ? AND did IN (${holes})`,
                bound,
                ...dids
            )
            .toArray()
            .map((r) => r.did)
        return { dids: changed, nextCursor: String(now) }
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

    /** Own-DID push, where a registration holds this DID. */
    protected onChange(_did: string, _rev: string): Promise<void> {
        return Promise.resolve()
    }

    /** A rev that moved backwards. Never silent in a real deployment. */
    protected onRegression(did: string, indexed: string, observed: string): Promise<void> {
        console.log("monitor: rev regression", { did, indexed, observed })
        return Promise.resolve()
    }

    private deps(): IngestDeps {
        return {
            index: this,
            snapshot: kvSnapshotStore(this.env),
            fetchRecord: (did) => this.fetchRecord(did),
            onChange: (did, rev) => this.onChange(did, rev),
            onRegression: (did, i, o) => this.onRegression(did, i, o),
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

    /** Open the stream at the stored cursor, or at the tip on first run. */
    async connect(): Promise<void> {
        if (this.socket !== null) return
        const cursor = await this.readCursor()
        const url = new URL(this.env.JETSTREAM_URL)
        url.searchParams.set("collections", this.env.MONITOR_COLLECTION)
        if (cursor !== null) url.searchParams.set("cursor", cursor)

        const response = await fetch(url, { headers: { Upgrade: "websocket" } })
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
        if ((await this.db.getAlarm()) === null) {
            await this.db.setAlarm(Date.now() + interval)
        }
    }

    /**
     * Watchdog and retry queue. Reconnects a dropped stream, then settles
     * what is owed — the only thing standing between a PDS outage and a
     * silently dropped DID, since the stream will not redeliver.
     */
    async alarm(): Promise<void> {
        try {
            if (this.socket === null) await this.connect()
        } finally {
            const batch = Number.parseInt(this.env.SETTLE_BATCH, 10)
            await settleDue(this.deps(), Number.isFinite(batch) ? batch : 32)
            // Sealed after settling, so anything confirmed on this wake
            // lands in a window before that window is closed out.
            await sealDueWindows({
                index: this,
                snapshot: kvSnapshotStore(this.env),
                widthMs: this.digestWidthMs(),
                nowMs: () => Date.now(),
            })
            const interval = Number.parseInt(this.env.WATCHDOG_INTERVAL_MS, 10)
            if (Number.isFinite(interval) && interval > 0) {
                await this.db.setAlarm(Date.now() + interval)
            }
        }
    }
}
