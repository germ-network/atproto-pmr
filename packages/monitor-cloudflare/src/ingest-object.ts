import { DurableObject } from "cloudflare:workers"
import {
    applyInterestTransitions,
    compareRev,
    decodeEvent,
    fetchRecordCar,
    decodePlcExportFrame,
    drainKeyUpdates,
    drainPlcLogs,
    FETCH_AS_OF_SKEW_MS,
    intake,
    intakePlcEvent,
    routeFollowEvent,
    listReposByCollection,
    plcCursorAfterClose,
    BLOCK_COLLECTION_NSID,
    FOLLOW_COLLECTION_NSID,
    fetchHeadRev,
    pushDeclarationChange,
    recordWatchedDocument,
    refreshDue,
    sealDueWindows,
    settleDue,
    settleSecondaryDue,
    sweepBackfill,
    windowOf,
    type BackfillProgress,
    type DidDocumentSink,
    type Cursor,
    type FetchedRecord,
    type HeadRev,
    type HolderState,
    type IndexedRecord,
    type IngestDeps,
    type IntakeOutcome,
    type InterestIndex,
    type InterestTransition,
    type FollowStreamIndex,
    type EdgeCollection,
    type NewEdgeOp,
    type OwedRecord,
    type PendingRecordFetch,
    type RecordRef,
    type SecondaryDeps,
    type SecondaryIndex,
    type SecondaryIntakeIndex,
    type SecondaryIntakeOutcome,
    type SecondaryWriteAnswer,
    type KeyUpdateIndex,
    type MonitorIndex,
    type OwedKeyUpdate,
    type PendingFetch,
    type RefreshIndex,
    type SigningKeyUpdate,
    type VerifiedWrite,
    type VerifyOutcome,
    type GraphMirrorDeps,
    type GraphMirrorIndex,
    runGraphProjector,
    type GraphProjectorIndex,
    type MirroredGraphStanding,
    type PlcLogIndex,
    type ProjectorCursor,
    type GraphMirrorRow,
    type GraphMirrorTransition,
    type MirrorReconcileCursor,
    type EdgeOp,
    type EdgeOpsIndex,
    type OwnerFollowedIndex,
    type QueuedRecount,
    type RecountQueueIndex,
    type FetchedRepo,
    type ResolvedPds,
    type FollowPage,
    type StagedRow,
    type ListingIndex,
    type ListingKind,
    type ListingQueueReason,
    type QueuedListing,
    type StartedListing,
    drainRecounts,
    fetchRepoCar,
    flushEdgeOps,
    flushLimit,
    followGapExceeded,
    listEdgeRecords,
    mirrorGraph,
    pruneGraphChanges,
    reconcileGraphMirror,
    reconcileOwnerFollowers,
    relistStale,
    runListings,
} from "@germ-network/atproto-pmr-monitor"
import type {
    FollowBackfillConfig,
    FollowBackfillDeps,
    ListingProgress,
    StatementBudget,
} from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeStore, d1BlockEdgeWriter } from "./block-edge-store"
import { d1FollowEdgeStore, d1FollowEdgeWriter, statementBudget } from "./follow-edge-store"
import { d1GraphChangeLog } from "./graph-change-log"
import { kvGraphProjections } from "./graph-projection-store"
import {
    DEFAULT_MAX_MST_NODES,
    appendPlcLogEntry,
    fetchDidDocument,
    fetchPlcAuditLog,
    pdsResolutionFromDocument,
    RepoProofError,
    STORED_DID_DOCUMENT_MAX_AGE_MS,
    verifyPlcLog,
    verifyRecordProofOutcome,
    verifyRepoCollections,
    type BlockEdge,
    type DidDocument,
    type InterestPolicy,
    type MonitorRegistrationNotify,
    type MonitorOwnBlocksRequest,
    type MonitorOwnGraphRequest,
    type OwnerGraph,
    ownerGraph,
    type MonitorRecheckRequest,
    type PlcLog,
    type PlcLogEntry,
    type PlcCoverage,
    type RepoCollectionsExpectation,
    type VerifiedCollections,
    type WatchedRecord,
} from "@germ-network/atproto-pmr-core"
import {
    canonicalDidDocumentJson,
    kvDidDocumentWriter,
    kvPlcLogWriter,
    PLC_COVERAGE_KEY,
} from "./did-document-store"
import { interestPolicy as policyFromEnv, monitorCollections, type MonitorEnv } from "./env"
import { monitorWebPushSender } from "./push-sender"
import { kvMonitorRegistrationStore } from "./registration-store"
import { kvSigningKeyCache } from "./signing-key-store"
import { kvSnapshotStore } from "./snapshot-store"

/** A re-check request not selected within this much wall-clock time is dropped. */
const REFRESH_REQUEST_MAX_AGE_MS = 86_400_000

/** DIDs the refresh queue covers; `policy` names the bound parameter holding the interest policy. */
const refreshCandidates = (policy: string) =>
    "(SELECT did FROM interest WHERE member = 1 " +
    `UNION SELECT did FROM holder_state WHERE state = 'gone-reversible' AND ${policy} = 'everyone')`

/**
 * Bound on the Jetstream WebSocket upgrade, matching the fetch guards in
 * `@germ-network/atproto-pmr-core`'s `atproto-fetch.ts` (also 5s) — this
 * runs on the same single-threaded object those calls run alongside,
 * outside `connect`, so an unbounded network call here is exactly the
 * same hazard.
 */
const CONNECT_TIMEOUT_MS = 5_000

/** KV puts one alarm may spend on stored DID documents. */
const DID_DOCUMENT_PUBLISH_BATCH = 64
const PLC_LOG_PUBLISH_BATCH = 64

type PublishRow = {
    did: string
    document: string
    confirmed_at: number
    version: number
}

/** Owed key updates applied per drain. */
const KEY_DRAIN_BATCH = 64

/**
 * Longest the PLC cursor goes unpersisted while the stream runs. A lost
 * tail only replays ops, which is idempotent; persisting per frame would
 * cost a write for every op the directory accepts.
 */
const PLC_CURSOR_PERSIST_MS = 5_000
/** How often ignored declaration-stream events move the persisted cursor. */
const IGNORED_CURSOR_PERSIST_MS = 5_000

/** How often the registered set is re-listed from the directory. */
const RECONCILE_INTERVAL_MS = 86_400_000
/** How often the D1 graph mirror is checked against the single writer's state, both ways. */
const GRAPH_RECONCILE_INTERVAL_MS = 86_400_000
/** D1 statements the writer spends per mirrored DID. */
const MIRROR_STATEMENTS_PER_DID = 11
const RECOUNT_DRAIN_BATCH = 1000
const OWNER_RECONCILE_BATCH = 200
/** `listRecords` pages all listings together take per alarm. */
const LISTING_PAGES_PER_ALARM = 200
/** `listRecords` listings (mutual, and at most one paged owner) in progress at once. */
const LISTRECORDS_IN_PROGRESS = 100
/** Stale listings queued per alarm, counting what is already due. */
const STALE_RELIST_PER_ALARM = 200
/** Consecutive getRepo timeouts after which an owner is listed by pages; for a `listRecords` listing, fetch failures after which it is unlistable. */
const FOLLOW_TIMEOUTS_BEFORE_PAGED = 3
/** Consecutive permanent-class failures after which a listing is unlistable. */
const FOLLOW_UNLISTABLE_AFTER = 5
const LISTING_RETRY_BASE_MS = 60_000
const LISTING_RETRY_MAX_MS = 86_400_000

interface MirrorSqlRow extends Record<string, SqlStorageValue> {
    did: string
    owner: number
    holder: number
    member: number
    registered: number
}
interface PriorSqlRow extends Record<string, SqlStorageValue> {
    m_did: string | null
    m_owner: number
    m_holder: number
    m_member: number
    m_registered: number
}

interface QueueSqlRow extends Record<string, SqlStorageValue> {
    did: string
    attempts: number
    not_before: number
    timeouts: number
    permanent_failures: number
    paged: number
    progress_kind: string | null
    progress_gen: number | null
    progress_phase: string | null
    progress_collection: EdgeCollection | null
    progress_cursor: string | null
    progress_pds: string | null
    progress_began_at: number | null
    progress_pages: number
}

const queuedListing = (r: QueueSqlRow): QueuedListing => ({
    did: r.did,
    attempts: r.attempts,
    notBeforeMs: r.not_before,
    timeouts: r.timeouts,
    permanentFailures: r.permanent_failures,
    paged: r.paged === 1,
    inProgress:
        r.progress_kind === null
            ? null
            : ({
                  kind: r.progress_kind,
                  gen: r.progress_gen,
                  phase: r.progress_phase,
                  collection: r.progress_collection ?? "follow",
                  cursor: r.progress_cursor,
                  pds: r.progress_pds,
                  beganAtMs: r.progress_began_at,
                  pages: r.progress_pages,
              } as ListingProgress),
})

const mirrorRow = (r: MirrorSqlRow): GraphMirrorRow => ({
    did: r.did,
    owner: r.owner === 1,
    holder: r.holder === 1,
    member: r.member === 1,
    registered: r.registered === 1,
})

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
 * PLC directory's export stream, with its own cursor and a run of unbroken
 * coverage (which `plc:coverage` publishes); that one stream feeds both the
 * owed signing-key updates and the stored DID documents.
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
 * own PDS is a policy decision (which resolver, which timeouts) that belongs
 * to a deployment, not to a storage adapter; verifying what it returns is not.
 * The secondary records' fetch (`fetchRecordAt`) and the head read
 * (`fetchHeadRev`) do have working defaults over the global `fetch`, which a
 * deployment may override the same way.
 */
export class MonitorIngest
    extends DurableObject<MonitorEnv>
    implements
        MonitorIndex,
        RefreshIndex,
        KeyUpdateIndex,
        DidDocumentSink,
        InterestIndex,
        SecondaryIndex,
        SecondaryIntakeIndex,
        FollowStreamIndex,
        ListingIndex,
        EdgeOpsIndex,
        GraphMirrorIndex,
        GraphProjectorIndex,
        PlcLogIndex,
        OwnerFollowedIndex,
        RecountQueueIndex,
        MonitorRegistrationNotify,
        MonitorRecheckRequest,
        MonitorOwnBlocksRequest,
        MonitorOwnGraphRequest
{
    private readonly db: DurableObjectStorage
    private socket: WebSocket | null = null
    private plcSocket: WebSocket | null = null
    private followSocket: WebSocket | null = null
    private followCursorPersistedAt = 0
    private followConnectedAt = 0
    /**
     * The highest export `seq` seen, shared by every path that advances the
     * PLC cursor so a lazy flush can never write an older value over a
     * newer one. Cleared with the stored row on reset.
     */
    private plcSeq: number | null = null
    private plcPersistedAt = 0
    /** Frames and closes of the PLC socket, handled one at a time in arrival order. */
    private plcChain: Promise<void> = Promise.resolve()
    /** The `createdAt` high-water mark and the start of the stream's current unbroken run. */
    private plcHighCreatedAtMs: number | null = null
    private plcContinuousSinceMs: number | null = null
    /** Whether the stored cursor row carries the current run's start. */
    private plcRunPersisted = false
    /** What `plc:coverage` last claimed in this run. */
    private plcCoveredThroughMs: number | null = null
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
                CREATE TABLE IF NOT EXISTS did_documents (
                    did TEXT PRIMARY KEY,
                    document TEXT NOT NULL,
                    as_of INTEGER NOT NULL,
                    confirmed_at INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    published_version INTEGER,
                    published_confirmed_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS key_updates (
                    did TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    key TEXT,
                    as_of INTEGER,
                    version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS records (
                    did TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    rkey TEXT NOT NULL,
                    rev TEXT NOT NULL,
                    cid TEXT NOT NULL,
                    verified_with TEXT NOT NULL,
                    PRIMARY KEY (did, collection, rkey)
                );
                CREATE TABLE IF NOT EXISTS holder_state (
                    did TEXT PRIMARY KEY,
                    state TEXT NOT NULL CHECK (state IN ('held', 'gone-reversible', 'gone-permanent')),
                    held_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS interest (
                    did TEXT PRIMARY KEY,
                    registered INTEGER NOT NULL DEFAULT 0,
                    owner_followers INTEGER NOT NULL DEFAULT 0,
                    since INTEGER NOT NULL DEFAULT 0,
                    member INTEGER NOT NULL DEFAULT 0,
                    epoch INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS rec_pending (
                    did TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    rkey TEXT NOT NULL,
                    rev TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    not_before INTEGER NOT NULL DEFAULT 0,
                    epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (did, collection, rkey)
                );
                CREATE TABLE IF NOT EXISTS reg_state (
                    did TEXT PRIMARY KEY,
                    registered_at INTEGER NOT NULL DEFAULT 0,
                    unregistered_at INTEGER NOT NULL DEFAULT 0,
                    unregister_due INTEGER,
                    mark INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS interest_transitions (
                    did TEXT PRIMARY KEY,
                    change TEXT NOT NULL CHECK (change IN ('join', 'leave')),
                    epoch INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS edge_ops (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK (kind IN ('create', 'delete')),
                    follower TEXT NOT NULL,
                    rkey TEXT NOT NULL,
                    subject TEXT,
                    rev TEXT NOT NULL,
                    cursor TEXT NOT NULL,
                    collection TEXT NOT NULL DEFAULT 'follow'
                );
                CREATE TABLE IF NOT EXISTS listing_requeue (
                    did TEXT PRIMARY KEY,
                    queued_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS listings (
                    did TEXT PRIMARY KEY,
                    listed_at INTEGER,
                    owner_listed_at INTEGER,
                    paged INTEGER NOT NULL DEFAULT 0,
                    progress_kind TEXT,
                    progress_gen INTEGER,
                    progress_phase TEXT,
                    progress_collection TEXT,
                    progress_cursor TEXT,
                    progress_pds TEXT,
                    progress_began_at INTEGER,
                    progress_pages INTEGER NOT NULL DEFAULT 0,
                    last_kind TEXT
                );
                CREATE INDEX IF NOT EXISTS listings_by_listed_at ON listings (listed_at);
                CREATE TABLE IF NOT EXISTS listing_stage (
                    did TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    rkey TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    PRIMARY KEY (did, collection, rkey)
                );
                CREATE TABLE IF NOT EXISTS recount_queue (
                    did TEXT PRIMARY KEY,
                    queued_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS graph_mirrored (
                    did TEXT PRIMARY KEY,
                    owner INTEGER NOT NULL,
                    holder INTEGER NOT NULL,
                    member INTEGER NOT NULL,
                    registered INTEGER NOT NULL,
                    inflight INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS checks (
                    did TEXT PRIMARY KEY,
                    checked_at INTEGER NOT NULL,
                    attempted_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS plc_logs (
                    did TEXT PRIMARY KEY,
                    log TEXT,
                    as_of INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1,
                    published_version INTEGER,
                    owed_at INTEGER,
                    attempted_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS refresh_requests (
                    did TEXT PRIMARY KEY,
                    requested_at INTEGER NOT NULL
                );
            `)
            if (
                this.db.sql
                    .exec("SELECT 1 FROM pragma_table_info('pending') WHERE name = 'quiet'")
                    .toArray().length === 0
            ) {
                this.db.sql.exec("ALTER TABLE pending ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0")
            }
            if (
                this.db.sql
                    .exec("SELECT 1 FROM pragma_table_info('listing_stage') WHERE name = 'collection'")
                    .toArray().length === 0
            ) {
                // Staged rows predate block listings, and their primary key
                // cannot gain a column: restart each listing from its queue row,
                // since a drain over emptied staging would sweep every older
                // edge. No await separates these writes, so they commit together.
                this.db.sql.exec("DROP TABLE listing_stage")
                this.db.sql.exec(
                    "CREATE TABLE listing_stage (did TEXT NOT NULL, collection TEXT NOT NULL, " +
                        "rkey TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (did, collection, rkey))"
                )
                this.db.sql.exec(
                    "UPDATE listings SET progress_kind = NULL, progress_gen = NULL, progress_phase = NULL, " +
                        "progress_cursor = NULL, progress_pds = NULL, progress_began_at = NULL, progress_pages = 0"
                )
            }
            if (
                this.db.sql
                    .exec("SELECT 1 FROM pragma_table_info('listings') WHERE name = 'progress_collection'")
                    .toArray().length === 0
            ) {
                this.db.sql.exec("ALTER TABLE listings ADD COLUMN progress_collection TEXT")
            }
            if (
                this.db.sql
                    .exec("SELECT 1 FROM pragma_table_info('edge_ops') WHERE name = 'collection'")
                    .toArray().length === 0
            ) {
                this.db.sql.exec("ALTER TABLE edge_ops ADD COLUMN collection TEXT NOT NULL DEFAULT 'follow'")
            }
            for (const column of [
                "attempts",
                "not_before",
                "timeouts",
                "permanent_failures",
                "unlistable",
                "low_priority",
            ]) {
                if (
                    this.db.sql
                        .exec(
                            "SELECT 1 FROM pragma_table_info('listing_requeue') WHERE name = ?",
                            column
                        )
                        .toArray().length === 0
                ) {
                    this.db.sql.exec(
                        `ALTER TABLE listing_requeue ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
                    )
                }
            }
            this.assertConfig()
            this.seedHolderState()
            this.seedInterest()
            this.seedListings()
            this.seedPlcLogs()
        })
    }

    /** Once: every kept did:plc DID already in interest is owed its first log fetch. */
    private seedPlcLogs(): void {
        if (this.metaOf("plc_logs_seeded") !== undefined) return
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "INSERT OR IGNORE INTO plc_logs (did, owed_at) " +
                    "SELECT did, ? FROM interest WHERE member = 1 AND did LIKE 'did:plc:%' " +
                    "AND did NOT IN (SELECT did FROM deleted)",
                Date.now()
            )
            this.setMeta("plc_logs_seeded", "1")
        })
    }

    // ---- KeyUpdateIndex ---------------------------------------------------

    /**
     * The cursor is per directory host, so one stored for a different
     * `PLC_EXPORT_STREAM_URL` reads as none, and is dropped. A cursor
     * stored for this URL also restores the run it belongs to (so an
     * eviction does not restart the coverage run); a live object already
     * holds both in memory.
     */
    async readPlcCursor(): Promise<number | null> {
        if (this.plcSeq !== null) return this.plcSeq
        const row = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
            .toArray()[0]
        if (row === undefined) return null
        try {
            const stored = JSON.parse(row.v) as {
                url?: unknown
                seq?: unknown
                continuousSinceMs?: unknown
            }
            if (stored.url !== this.plcUrl() || typeof stored.seq !== "number") {
                if (this.plcUrl() !== null) await this.resetPlcCursor()
                return null
            }
            this.plcSeq = stored.seq
            if (typeof stored.continuousSinceMs === "number") {
                this.plcContinuousSinceMs = stored.continuousSinceMs
                this.plcRunPersisted = true
            }
            return stored.seq
        } catch {
            return null
        }
    }

    async advancePlcCursor(seq: number, createdAtMs?: number): Promise<void> {
        await this.readPlcCursor()
        this.raisePlcCursor(seq, createdAtMs)
        if (Date.now() - this.plcPersistedAt >= PLC_CURSOR_PERSIST_MS) this.persistPlcCursor()
    }

    /**
     * Clears the stored row and the in-memory cursor together, and ends the
     * unbroken run: the next frame's `createdAt` starts a new one.
     */
    async resetPlcCursor(): Promise<void> {
        this.plcSeq = null
        this.plcHighCreatedAtMs = null
        this.plcContinuousSinceMs = null
        this.plcPersistedAt = 0
        this.plcRunPersisted = false
        this.plcCoveredThroughMs = null
        this.db.sql.exec("DELETE FROM meta WHERE k = 'plc_cursor'")
    }

    async isWatched(did: string): Promise<boolean> {
        const row = this.db.sql
            .exec<{ n: number }>(
                "SELECT 1 AS n WHERE (EXISTS (SELECT 1 FROM interest WHERE did = ?1 AND member = 1) " +
                    "OR EXISTS (SELECT 1 FROM pending WHERE did = ?1) " +
                    "OR (?2 = 'registered' AND (EXISTS (SELECT 1 FROM revs WHERE did = ?1) " +
                    "OR EXISTS (SELECT 1 FROM records WHERE did = ?1)))) " +
                    "AND NOT EXISTS (SELECT 1 FROM deleted WHERE did = ?1)",
                did,
                this.interestPolicy()
            )
            .toArray()[0]
        return row !== undefined
    }

    /** Replaces any update already owed for `did`, and bumps its version. */
    async oweKeyUpdate(
        did: string,
        update: SigningKeyUpdate,
        plcSeq?: number,
        createdAtMs?: number
    ): Promise<void> {
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
            this.raisePlcCursor(plcSeq, createdAtMs)
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

    private raisePlcCursor(seq: number, createdAtMs?: number): void {
        this.plcSeq = Math.max(this.plcSeq ?? seq, seq)
        if (createdAtMs === undefined) return
        if (this.plcContinuousSinceMs === null) {
            // A new unbroken run: operations in the gap before it may be missing from every held log.
            this.db.sql.exec(
                "UPDATE plc_logs SET owed_at = ? WHERE log IS NOT NULL AND owed_at IS NULL",
                Date.now()
            )
        }
        this.plcContinuousSinceMs ??= createdAtMs
        this.plcHighCreatedAtMs = Math.max(this.plcHighCreatedAtMs ?? createdAtMs, createdAtMs)
    }

    /**
     * Write the high-water seq and the run's start beside the stream's URL.
     * The alarm calls it too, so a lazy flush is never what the run waits on.
     */
    persistPlcCursor(): void {
        if (this.plcSeq === null || this.plcUrl() === null) return
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('plc_cursor', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            JSON.stringify({
                url: this.plcUrl(),
                seq: this.plcSeq,
                continuousSinceMs: this.plcContinuousSinceMs,
            })
        )
        this.plcPersistedAt = Date.now()
        this.plcRunPersisted = this.plcContinuousSinceMs !== null
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
        this.markDidDocumentStaleSync(did, asOfMs)
    }

    private markDidDocumentStaleSync(did: string, asOfMs: number): void {
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
     * (so an unchanged document costs at most two KV writes a day, plus one
     * when a new unbroken run begins); then any whose KV confirmation predates
     * the stream's current unbroken run while its stored one does not. Marks published the version and confirmation
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
        const highWater = this.plcHighCreatedAtMs
        const runStart = this.plcContinuousSinceMs
        const writer = kvDidDocumentWriter(this.env)

        const changed = this.db.sql
            .exec<PublishRow>(
                "SELECT did, document, confirmed_at, version FROM did_documents " +
                    "WHERE published_version IS NULL OR published_version != version " +
                    "ORDER BY as_of LIMIT ?",
                limit
            )
            .toArray()
        const reconfirm =
            changed.length >= limit
                ? []
                : this.db.sql
                      .exec<PublishRow>(
                          "SELECT did, document, confirmed_at, version FROM did_documents " +
                              "WHERE published_version = version AND document NOT IN ('null', '') AND (" +
                              "confirmed_at - published_confirmed_at >= ? " +
                              "OR (? IS NOT NULL AND published_confirmed_at < ? AND ? <= confirmed_at)) " +
                              "ORDER BY confirmed_at - published_confirmed_at DESC LIMIT ?",
                          STORED_DID_DOCUMENT_MAX_AGE_MS / 2,
                          runStart,
                          runStart,
                          runStart,
                          limit - changed.length
                      )
                      .toArray()

        let published = 0
        for (const row of [...changed, ...reconfirm]) {
            try {
                if (row.confirmed_at > 0 && row.document !== "null" && row.document !== "") {
                    await writer.put(row.did, {
                        doc: JSON.parse(row.document) as DidDocument,
                        fetchedAtMs: row.confirmed_at,
                        source: row.did.startsWith("did:plc:") ? "plc" : "web",
                    })
                } else {
                    await writer.delete(row.did)
                }
            } catch {
                continue
            }
            this.db.sql.exec(
                "UPDATE did_documents SET published_version = ?, published_confirmed_at = ? " +
                    "WHERE did = ?",
                row.version,
                row.confirmed_at,
                row.did
            )
            published += 1
        }

        const remaining = this.db.sql
            .exec<{ n: number }>(
                "SELECT COUNT(*) AS n FROM did_documents " +
                    "WHERE published_version IS NULL OR published_version != version"
            )
            .one().n
        return {
            published,
            remaining,
            coveredThroughMs: remaining === 0 ? highWater : null,
        }
    }

    /**
     * Publish `plc:coverage`, advancing `coveredThroughMs` to the given value
     * (from a drained `publishDidDocuments`) or re-publishing the previous
     * one when null. Called only after the cursor row holding the run's
     * `continuousSinceMs` is persisted; a no-op until a run has been
     * persisted, so KV never claims a run an eviction could lose.
     */
    async publishPlcCoverage(coveredThroughMs: number | null): Promise<void> {
        const url = this.env.PLC_EXPORT_STREAM_URL
        if (url === undefined || url === "") return
        if (!this.plcRunPersisted || this.plcContinuousSinceMs === null) return
        if (coveredThroughMs !== null) this.plcCoveredThroughMs = coveredThroughMs
        if (this.plcCoveredThroughMs === null) return
        const coverage: PlcCoverage = {
            url,
            continuousSinceMs: this.plcContinuousSinceMs,
            coveredThroughMs: this.plcCoveredThroughMs,
        }
        await this.env.records.put(PLC_COVERAGE_KEY, JSON.stringify(coverage))
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
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev, quiet = 0",
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
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev, quiet = 0",
            did,
            rev
        )
    }

    /** Discharge an obligation without indexing: a terminal, unstorable answer. */
    async clearPending(did: string): Promise<void> {
        this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
    }

    /**
     * Gives every DID already in `revs` or `deleted` a holder state, once:
     * held, or gone-permanent where a `deleted` row says so. A reversibly-gone
     * DID has a `revs` row and neither of those marks, so it is seeded held;
     * the refresh that finds it gone re-asserts gone-reversible.
     */
    private seedHolderState(): void {
        const seeded = this.db.sql
            .exec("SELECT 1 FROM meta WHERE k = 'holder_seeded'")
            .toArray()
        if (seeded.length > 0) return
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "INSERT OR IGNORE INTO holder_state (did, state, held_at) " +
                    "SELECT r.did, CASE WHEN d.did IS NULL THEN 'held' ELSE 'gone-permanent' END, " +
                    "r.observed_at FROM revs r LEFT JOIN deleted d ON d.did = r.did"
            )
            this.db.sql.exec(
                "INSERT OR IGNORE INTO holder_state (did, state) " +
                    "SELECT did, 'gone-permanent' FROM deleted"
            )
            this.db.sql.exec("INSERT INTO meta (k, v) VALUES ('holder_seeded', '1')")
        })
    }

    /**
     * Under `everyone`, once: every held holder joins interest (queued as a
     * join, so each is owed its secondaries), in the constructor's step so no
     * frame or settle ever sees a held DID as unwatched. A holder already
     * gone-reversible is not in interest and no leave will ever withdraw its
     * document, so that document is marked stale here.
     */
    private seedInterest(): void {
        if (this.interestPolicy() !== "everyone") return
        const seeded = this.db.sql
            .exec("SELECT 1 FROM meta WHERE k = 'interest_seeded'")
            .toArray()
        if (seeded.length > 0) return
        this.ctx.storage.transactionSync(() => {
            const nowMs = Date.now()
            this.db.sql.exec(
                "INSERT OR IGNORE INTO interest (did, member, epoch, since) " +
                    "SELECT did, 1, 1, held_at FROM holder_state WHERE state = 'held'"
            )
            this.db.sql.exec(
                "INSERT OR IGNORE INTO interest_transitions (did, change, epoch) " +
                    "SELECT did, 'join', 1 FROM holder_state WHERE state = 'held'"
            )
            const gone = this.db.sql
                .exec<{ did: string }>(
                    "SELECT did FROM holder_state WHERE state = 'gone-reversible'"
                )
                .toArray()
            for (const { did } of gone) this.markDidDocumentStaleSync(did, nowMs)
            this.db.sql.exec("INSERT INTO meta (k, v) VALUES ('interest_seeded', '1')")
        })
    }

    /** Once: every interest DID is queued for its first listing. */
    private seedListings(): void {
        if (this.metaOf("listings_seeded") !== undefined) return
        this.ctx.storage.transactionSync(() => {
            this.queueAllListingsSync(Date.now(), "upgrade")
            this.setMeta("listings_seeded", "1")
        })
    }

    /**
     * Recompute `did`'s membership from the policy and write a change: the
     * epoch moves and the join or leave is queued, replacing any still-queued
     * one: the latest change wins, so a leave then a join before the alarm
     * re-owes the DID's records and disposes of nothing, and a join then a
     * leave still disposes. Membership is judged under the policy in force, so
     * the policy must not change for the life of the object.
     */
    private reevaluateInterest(did: string, atMs: number, ownedBefore: boolean): void {
        const row = this.db.sql
            .exec<{ registered: number; owner_followers: number; member: number; epoch: number }>(
                "SELECT registered, owner_followers, member, epoch FROM interest WHERE did = ?",
                did
            )
            .toArray()[0]
        const registered = (row?.registered ?? 0) === 1
        const want =
            this.interestPolicy() === "registered"
                ? registered || (row?.owner_followers ?? 0) > 0
                : registered || this.holderStateSync(did) === "held"
        const current = (row?.member ?? 0) === 1
        if (want !== current) {
            const epoch = (row?.epoch ?? 0) + 1
            this.db.sql.exec(
                "INSERT INTO interest (did, member, epoch, since) VALUES (?1, ?2, ?3, ?4) " +
                    "ON CONFLICT(did) DO UPDATE SET member = ?2, epoch = ?3, " +
                    "since = CASE WHEN ?2 = 1 THEN ?4 ELSE since END",
                did,
                want ? 1 : 0,
                epoch,
                atMs
            )
            const change = want ? "join" : "leave"
            this.db.sql.exec(
                "INSERT INTO interest_transitions (did, change, epoch) VALUES (?, ?, ?) " +
                    "ON CONFLICT(did) DO UPDATE SET change = excluded.change, epoch = excluded.epoch",
                did,
                change,
                epoch
            )
            if (want) this.queueListingSync(did, atMs, "join")
            else this.dropListingSync(did)
        }
        const owns = this.ownsSync(did)
        if (owns === ownedBefore) return
        if (!owns) {
            this.db.sql.exec("UPDATE listings SET owner_listed_at = NULL WHERE did = ?", did)
        }
        if (want) this.queueListingSync(did, atMs, "ownership")
    }

    /** Ownership of a graph by policy: registered under `registered`, held under `everyone`. */
    private ownsSync(did: string): boolean {
        if (this.interestPolicy() === "registered") {
            return (
                this.db.sql
                    .exec("SELECT 1 FROM interest WHERE did = ? AND registered = 1", did)
                    .toArray().length > 0
            )
        }
        return this.holderStateSync(did) === "held"
    }

    private holderStateSync(did: string): HolderState | null {
        return (
            this.db.sql
                .exec<{ state: HolderState }>("SELECT state FROM holder_state WHERE did = ?", did)
                .toArray()[0]?.state ?? null
        )
    }

    async recordsOf(did: string): Promise<IndexedRecord[]> {
        return this.db.sql
            .exec<{
                did: string
                collection: string
                rkey: string
                rev: string
                cid: string
                verified_with: string
            }>("SELECT did, collection, rkey, rev, cid, verified_with FROM records WHERE did = ?", did)
            .toArray()
            .map((r) => ({
                did: r.did,
                collection: r.collection,
                rkey: r.rkey,
                rev: r.rev,
                cid: r.cid,
                verifiedWith: r.verified_with,
            }))
    }

    async holderStateOf(did: string): Promise<HolderState | null> {
        const row = this.db.sql
            .exec<{ state: HolderState }>("SELECT state FROM holder_state WHERE did = ?", did)
            .toArray()[0]
        return row?.state ?? null
    }

    /** The rev, the verified declaration row and the held mark, in one step. */
    private writeVerified(
        did: string,
        rev: string,
        observedAtMs: number,
        verified: VerifiedWrite
    ): void {
        const ownedBefore = this.ownsSync(did)
        this.db.sql.exec(
            "INSERT INTO revs (did, rev, observed_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(did) DO UPDATE SET rev = excluded.rev, observed_at = excluded.observed_at",
            did,
            rev,
            observedAtMs
        )
        this.db.sql.exec(
            "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) " +
                "VALUES (?, ?, 'self', ?, ?, ?) " +
                "ON CONFLICT(did, collection, rkey) DO UPDATE SET rev = excluded.rev, " +
                "cid = excluded.cid, verified_with = excluded.verified_with",
            did,
            this.env.MONITOR_COLLECTION,
            rev,
            verified.cid,
            verified.verifiedWith
        )
        // Only a transition into held restarts `held_at`. A permanently deleted
        // DID is not re-marked here: refresh never visits one.
        this.db.sql.exec(
            "INSERT INTO holder_state (did, state, held_at) VALUES (?1, 'held', ?2) " +
                "ON CONFLICT(did) DO UPDATE SET state = 'held', " +
                "held_at = CASE WHEN state = 'held' THEN held_at ELSE ?2 END",
            did,
            observedAtMs
        )
        this.reevaluateInterest(did, observedAtMs, ownedBefore)
    }

    /**
     * A refresh found `did` reversibly gone with nothing left to dispose of:
     * re-assert the state with no digest entry and no push. Stays
     * gone-permanent for a DID with a `deleted` row.
     */
    async markGoneReversible(did: string): Promise<void> {
        this.ctx.storage.transactionSync(() => this.setGoneState(did, false))
    }

    private setGoneState(did: string, permanent: boolean): void {
        const ownedBefore = this.ownsSync(did)
        // A DID already permanently gone stays so under a reversible answer.
        this.db.sql.exec(
            "INSERT INTO holder_state (did, state) VALUES (?1, ?2) " +
                "ON CONFLICT(did) DO UPDATE SET state = CASE " +
                "WHEN EXISTS (SELECT 1 FROM deleted WHERE did = ?1) THEN 'gone-permanent' " +
                "ELSE excluded.state END",
            did,
            permanent ? "gone-permanent" : "gone-reversible"
        )
        this.reevaluateInterest(did, Date.now(), ownedBefore)
    }

    /**
     * Index the rev, add the DID to the open digest window, and clear the
     * obligation — after the bytes are durable, and in one transaction with the
     * declaration's `records` row and held mark.
     *
     * The window is chosen by **observation time**, `observedAtMs`, not by
     * when the change happened: a sealed filter cannot be amended, and the
     * retry path settles arbitrarily late.
     *
     * Also drops any `deleted` mark for `did` — reaching here at all means
     * the ordinary commit path just fetched and stored a live record for
     * it, so a prior deletion no longer holds.
     */
    async complete(
        did: string,
        rev: string,
        observedAtMs: number,
        verified: VerifiedWrite
    ): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.writeVerified(did, rev, observedAtMs, verified)
            this.db.sql.exec(
                "INSERT INTO window_members (window, did) VALUES (?, ?) " +
                    "ON CONFLICT(window, did) DO NOTHING",
                windowOf(observedAtMs, this.digestWidthMs()),
                did
            )
            this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
            this.db.sql.exec("DELETE FROM deleted WHERE did = ?", did)
        })
    }

    /**
     * Deletion's counterpart to `complete`: add `did` to the open digest
     * window the same way a stored change would, and discharge the
     * pending row, drop the declaration's `records` row and set the holder
     * state — one transaction. Deliberately leaves `revs` untouched; see
     * `MonitorIndex.completeDeletion`.
     *
     * `permanent` gates only the `deleted` row — see that method's own
     * doc for why a reversible state must NOT mark `did` `isDeleted`.
     */
    async completeDeletion(
        did: string,
        observedAtMs: number,
        permanent: boolean,
        quiet = false
    ): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            if (permanent) {
                this.db.sql.exec(
                    "INSERT INTO deleted (did, deleted_at) VALUES (?, ?) " +
                        "ON CONFLICT(did) DO UPDATE SET deleted_at = excluded.deleted_at",
                    did,
                    observedAtMs
                )
                this.dropPlcLogSync(did)
            }
            this.setGoneState(did, permanent)
            // Only the declaration goes: other collections' snapshots outlive it.
            this.db.sql.exec(
                "DELETE FROM records WHERE did = ? AND collection = ?",
                did,
                this.env.MONITOR_COLLECTION
            )
            if (!quiet) {
                this.db.sql.exec(
                    "INSERT INTO window_members (window, did) VALUES (?, ?) " +
                        "ON CONFLICT(window, did) DO NOTHING",
                    windowOf(observedAtMs, this.digestWidthMs()),
                    did
                )
            }
            this.db.sql.exec("DELETE FROM pending WHERE did = ?", did)
        })
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
            .exec<{ did: string; rev: string; attempts: number; not_before: number; quiet: number }>(
                "SELECT did, rev, attempts, not_before, quiet FROM pending " +
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
                quiet: r.quiet === 1,
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
     * The interest set (plus, under `everyone`, reversibly gone holders, so a
     * reversal is still found by polling) not confirmed or attempted since
     * its bound: `checkedBeforeMs` for a DID with a holder state,
     * `nonHolderCheckedBeforeMs` for one without. A DID counts as confirmed
     * at its last check, its last store or its join, whichever is latest, and
     * a DID attempted since its bound is not due, so one whose source keeps
     * failing, or whose record will not verify, is retried once per its own
     * interval rather than on every alarm. Ordered by the later of the
     * confirmation and the last attempt, so such a DID queues behind the
     * healthy ones. A DID owed a fetch (a declaration, or a secondary) is left
     * to that settle. Requested DIDs (`requestRefresh`) that are due come
     * first, at most a quarter of the batch (at least one), and a returned
     * DID's request is cleared.
     */
    async dueRefresh(
        checkedBeforeMs: number,
        limit: number,
        nonHolderCheckedBeforeMs: number
    ): Promise<string[]> {
        const policy = this.interestPolicy()
        const due = (tail: string, take: number): string[] =>
            this.db.sql
                .exec<{ did: string }>(
                    "SELECT d.did AS did, " +
                        "CASE WHEN h.did IS NOT NULL THEN ?1 ELSE ?2 END AS bound, " +
                        "MAX(COALESCE(r.observed_at, 0), COALESCE(c.checked_at, 0), COALESCE(i.since, 0)) AS confirmed, " +
                        "MAX(COALESCE(r.observed_at, 0), COALESCE(c.checked_at, 0), COALESCE(i.since, 0), " +
                        "COALESCE(c.attempted_at, 0)) AS last " +
                        "FROM " + refreshCandidates("?4") + " d " +
                        "LEFT JOIN revs r ON r.did = d.did " +
                        "LEFT JOIN checks c ON c.did = d.did " +
                        "LEFT JOIN interest i ON i.did = d.did " +
                        "LEFT JOIN holder_state h ON h.did = d.did " +
                        "LEFT JOIN refresh_requests q ON q.did = d.did " +
                        "WHERE d.did NOT IN (SELECT did FROM deleted) " +
                        "AND d.did NOT IN (SELECT did FROM pending) " +
                        "AND d.did NOT IN (SELECT did FROM rec_pending) " +
                        "AND confirmed < bound " +
                        "AND COALESCE(c.attempted_at, 0) < bound " +
                        tail,
                    checkedBeforeMs,
                    nonHolderCheckedBeforeMs,
                    take,
                    policy
                )
                .toArray()
                .map((r) => r.did)
        return this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "DELETE FROM refresh_requests WHERE requested_at < ?",
                Date.now() - REFRESH_REQUEST_MAX_AGE_MS
            )
            const requested = due(
                "AND q.did IS NOT NULL ORDER BY q.requested_at ASC LIMIT ?3",
                Math.min(limit, Math.max(1, Math.floor(limit / 4)))
            )
            const taken = new Set(requested)
            const rest = due("ORDER BY last ASC LIMIT ?3", limit)
                .filter((did) => !taken.has(did))
                .slice(0, Math.max(0, limit - requested.length))
            const dids = [...requested, ...rest]
            for (const did of dids) {
                this.db.sql.exec("DELETE FROM refresh_requests WHERE did = ?", did)
            }
            return dids
        })
    }

    /**
     * `MonitorOwnBlocksRequest`: the owner's own blocks, read from D1 outside
     * the alarm's statement budget. A D1 failure throws.
     */
    async ownBlocks(did: string): Promise<BlockEdge[] | null> {
        return d1BlockEdgeStore(this.env.graph!).ownBlocks(did)
    }

    /**
     * `MonitorOwnGraphRequest`: the owner's graph from the follow-edge index,
     * read from D1 outside the alarm's statement budget. A D1 failure throws.
     */
    async ownGraph(did: string): Promise<OwnerGraph | null> {
        const edges = await d1FollowEdgeStore(this.env.graph!).ownEdges(did)
        return edges === null ? null : ownerGraph(did, edges.following, edges.followers)
    }

    async requestRefresh(did: string, requestedAtMs: number): Promise<void> {
        // A repeat keeps the earliest time, so steady requests neither jump the
        // queue nor extend the request's one-day lifetime.
        this.db.sql.exec(
            "INSERT INTO refresh_requests (did, requested_at) " +
                "SELECT ?1, ?2 WHERE ?1 IN " + refreshCandidates("?3") + " " +
                "ON CONFLICT(did) DO UPDATE SET requested_at = MIN(requested_at, excluded.requested_at)",
            did,
            requestedAtMs,
            this.interestPolicy()
        )
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
     * stale. Writes the verified `records` row and asserts held.
     */
    async completeQuietly(
        did: string,
        rev: string,
        observedAtMs: number,
        verified: VerifiedWrite
    ): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.writeVerified(did, rev, observedAtMs, verified)
            // A live record again: the join obligation and any deletion mark
            // are spent, but a commit's obligation is still owed.
            this.db.sql.exec("DELETE FROM pending WHERE did = ? AND quiet = 1", did)
            this.db.sql.exec("DELETE FROM deleted WHERE did = ?", did)
        })
    }

    // ---- Registration (RPC from the relay's directory) ---------------------

    /**
     * Startup check: an unknown `INTEREST_POLICY` throws, and so does
     * `registered` without the `pmrDirectory` it reconciles against, or any
     * policy without the `graph` D1 binding.
     */
    assertConfig(): void {
        if (this.interestPolicy() === "registered" && this.env.pmrDirectory === undefined) {
            throw new Error("INTEREST_POLICY=registered requires a pmrDirectory binding")
        }
        if (this.env.graph === undefined) {
            throw new Error("the graph D1 binding is required")
        }
    }

    /**
     * The relay registered `did`: it joins interest, and any unregister
     * still waiting out `UNREGISTER_GRACE_MS` is cancelled.
     */
    async register(did: string): Promise<void> {
        const nowMs = Date.now()
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "INSERT INTO reg_state (did, registered_at) VALUES (?1, ?2) " +
                    "ON CONFLICT(did) DO UPDATE SET registered_at = ?2, unregister_due = NULL",
                did,
                nowMs
            )
            this.setRegisteredSync(did, true, nowMs)
        })
    }

    /**
     * The relay dropped `did`'s registration. Applied by the alarm once
     * `UNREGISTER_GRACE_MS` has passed with no `register` in between, so a
     * replace (unregister then register) disposes of nothing.
     */
    async unregister(did: string): Promise<void> {
        const nowMs = Date.now()
        this.db.sql.exec(
            "INSERT INTO reg_state (did, unregistered_at, unregister_due) VALUES (?1, ?2, ?3) " +
                "ON CONFLICT(did) DO UPDATE SET unregistered_at = ?2, unregister_due = ?3",
            did,
            nowMs,
            nowMs + this.registrationGraceMs()
        )
    }

    private registrationGraceMs(): number {
        return this.envInt(this.env.UNREGISTER_GRACE_MS, 600_000)
    }

    /**
     * How far a directory listing may disagree with the registrations the RPC
     * recorded: KV `list` is eventually consistent in both directions.
     */
    private reconcileMarginMs(): number {
        return Math.max(60_000, this.registrationGraceMs())
    }

    /** Apply every unregister whose grace has passed. */
    protected async applyExpiredUnregisters(nowMs: number): Promise<void> {
        const due = this.db.sql
            .exec<{ did: string }>(
                "SELECT did FROM reg_state WHERE unregister_due IS NOT NULL AND unregister_due <= ?",
                nowMs
            )
            .toArray()
        for (const { did } of due) {
            this.ctx.storage.transactionSync(() => {
                this.db.sql.exec("UPDATE reg_state SET unregister_due = NULL WHERE did = ?", did)
                this.setRegisteredSync(did, false, nowMs)
            })
        }
    }

    /**
     * Daily mark-and-sweep of the registered set against a full paged listing
     * of `pmrDirectory`: one complete pass marks every listed DID with the
     * pass's generation, then unmarks registrations older than the pass. A DID
     * registered after the pass began is never removed by it. One that has
     * never run is due at once. A no-op without the binding, which only
     * `everyone` allows. A listing that fails part-way removes nothing and is
     * retried by the next alarm. A registration whose unregister is waiting
     * out its grace is left to that grace.
     */
    protected async reconcileRegistrations(nowMs: number): Promise<void> {
        const directory = this.env.pmrDirectory
        if (directory === undefined) return
        const last = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'registrations_reconciled_at'")
            .toArray()[0]
        if (last !== undefined && nowMs - Number(last.v) < RECONCILE_INTERVAL_MS) return

        const margin = this.reconcileMarginMs()
        const cutoff = nowMs - margin
        let cursor: string | undefined
        for (;;) {
            const page = await directory.list({ prefix: "did:", cursor })
            for (const { name } of page.keys) {
                this.ctx.storage.transactionSync(() => this.markListed(name, nowMs, cutoff))
            }
            if (page.list_complete) break
            cursor = page.cursor
        }
        const stale = this.db.sql
            .exec<{ did: string }>(
                "SELECT i.did AS did FROM interest i LEFT JOIN reg_state r ON r.did = i.did " +
                    "WHERE i.registered = 1 AND COALESCE(r.mark, 0) != ?1 " +
                    "AND COALESCE(r.registered_at, 0) < ?2 AND r.unregister_due IS NULL",
                nowMs,
                cutoff
            )
            .toArray()
        this.ctx.storage.transactionSync(() => {
            for (const { did } of stale) this.setRegisteredSync(did, false, nowMs)
            this.db.sql.exec(
                "INSERT INTO meta (k, v) VALUES ('registrations_reconciled_at', ?1) " +
                    "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                String(nowMs)
            )
        })
    }

    /**
     * A listed DID is marked, and registered unless its unregister is
     * pending or newer than the margin, which the listing may not yet show.
     */
    private markListed(did: string, generation: number, cutoff: number): void {
        const row = this.db.sql
            .exec<{ unregistered_at: number; unregister_due: number | null }>(
                "SELECT unregistered_at, unregister_due FROM reg_state WHERE did = ?",
                did
            )
            .toArray()[0]
        const unregisterRecent =
            row !== undefined && (row.unregister_due !== null || row.unregistered_at > cutoff)
        this.db.sql.exec(
            "INSERT INTO reg_state (did, mark) VALUES (?1, ?2) " +
                "ON CONFLICT(did) DO UPDATE SET mark = ?2",
            did,
            generation
        )
        if (unregisterRecent) return
        const registered = this.db.sql
            .exec("SELECT 1 FROM interest WHERE did = ? AND registered = 1", did)
            .toArray()
        if (registered.length > 0) return
        this.db.sql.exec("UPDATE reg_state SET registered_at = ?2 WHERE did = ?1", did, generation)
        this.setRegisteredSync(did, true, generation)
    }

    /**
     * Once, after the first complete reconcile under `registered` (so the
     * registered set is no longer empty by omission): queue a leave for every
     * DID with a `revs` or `records` row that is outside interest. Until a
     * leave applies, such a DID stays watched.
     */
    protected queueRegisteredLeaves(): void {
        if (this.interestPolicy() !== "registered") return
        const flag = (k: string) =>
            this.db.sql.exec("SELECT 1 FROM meta WHERE k = ?", k).toArray().length > 0
        if (!flag("registrations_reconciled_at") || flag("registered_leaves_queued")) return
        this.ctx.storage.transactionSync(() => {
            const outside = this.db.sql
                .exec<{ did: string }>(
                    "SELECT did FROM (SELECT did FROM revs UNION SELECT did FROM records) " +
                        "WHERE did NOT IN (SELECT did FROM interest WHERE member = 1)"
                )
                .toArray()
            for (const { did } of outside) {
                this.db.sql.exec(
                    "INSERT INTO interest (did, member, epoch) VALUES (?1, 0, 1) " +
                        "ON CONFLICT(did) DO UPDATE SET epoch = epoch + 1",
                    did
                )
                const { epoch } = this.db.sql
                    .exec<{ epoch: number }>("SELECT epoch FROM interest WHERE did = ?", did)
                    .one()
                this.db.sql.exec(
                    "INSERT INTO interest_transitions (did, change, epoch) VALUES (?, 'leave', ?) " +
                        "ON CONFLICT(did) DO UPDATE SET change = 'leave', epoch = excluded.epoch",
                    did,
                    epoch
                )
            }
            this.db.sql.exec(
                "INSERT INTO meta (k, v) VALUES ('registered_leaves_queued', '1')"
            )
        })
    }

    // ---- InterestIndex ----------------------------------------------------

    interestPolicy(): InterestPolicy {
        return policyFromEnv(this.env)
    }

    async inInterest(did: string): Promise<boolean> {
        return (
            this.db.sql
                .exec("SELECT 1 FROM interest WHERE did = ? AND member = 1", did)
                .toArray().length > 0
        )
    }

    async interestEpoch(did: string): Promise<number> {
        return (
            this.db.sql
                .exec<{ epoch: number }>("SELECT epoch FROM interest WHERE did = ?", did)
                .toArray()[0]?.epoch ?? 0
        )
    }

    async isRegistered(did: string): Promise<boolean> {
        return (
            this.db.sql
                .exec("SELECT 1 FROM interest WHERE did = ? AND registered = 1", did)
                .toArray().length > 0
        )
    }

    // ---- PlcLogIndex ------------------------------------------------------

    /** Whether `did`'s log is kept: a watched did:plc DID. */
    private async keepsPlcLog(did: string): Promise<boolean> {
        return did.startsWith("did:plc:") && (await this.isWatched(did))
    }

    private plcLogRow(
        did: string
    ): { log: string | null; as_of: number; owed_at: number | null } | undefined {
        return this.db.sql
            .exec<{ log: string | null; as_of: number; owed_at: number | null }>(
                "SELECT log, as_of, owed_at FROM plc_logs WHERE did = ?",
                did
            )
            .toArray()[0]
    }

    async intakePlcLogEntry(did: string, entry: PlcLogEntry): Promise<void> {
        if (!(await this.keepsPlcLog(did))) return
        const row = this.plcLogRow(did)
        if (row?.log) {
            const held = JSON.parse(row.log) as PlcLog
            // A replayed operation is already in the log.
            if (held.entries.some((e) => e.cid === entry.cid)) return
            const next = appendPlcLogEntry(held, entry)
            if (next !== null) {
                this.db.sql.exec(
                    "UPDATE plc_logs SET log = ?, as_of = ?, version = version + 1 WHERE did = ?",
                    JSON.stringify(next),
                    next.asOfMs,
                    did
                )
                return
            }
        }
        await this.owePlcLog(did, Date.now())
    }

    async owePlcLog(did: string, owedAtMs: number): Promise<void> {
        if (!(await this.keepsPlcLog(did))) return
        this.db.sql.exec(
            "INSERT INTO plc_logs (did, owed_at) VALUES (?1, ?2) " +
                "ON CONFLICT(did) DO UPDATE SET owed_at = MAX(COALESCE(owed_at, 0), ?2)",
            did,
            owedAtMs
        )
    }

    async owedPlcLogs(attemptedBeforeMs: number, limit: number): Promise<string[]> {
        return this.db.sql
            .exec<{ did: string }>(
                "SELECT did FROM plc_logs WHERE owed_at IS NOT NULL AND attempted_at < ? " +
                    "ORDER BY owed_at LIMIT ?",
                attemptedBeforeMs,
                limit
            )
            .toArray()
            .map((r) => r.did)
    }

    async putPlcLog(log: PlcLog): Promise<void> {
        if (!(await this.keepsPlcLog(log.did))) {
            // No longer kept (or never): forget the debt rather than fetch it again.
            this.dropPlcLogSync(log.did)
            return
        }
        // The same verification a device runs; it also renders the document.
        const document = verifyPlcLog(log.did, log.entries)
        const row = this.plcLogRow(log.did)
        if (row?.log && row.as_of > log.asOfMs) {
            // The stream extended the held log after this fetch began, and the
            // fetched one may lack that operation: keep the held log and fetch again.
            const held = JSON.parse(row.log) as PlcLog
            const last = held.entries[held.entries.length - 1]!.cid
            if (!log.entries.some((e) => e.cid === last)) {
                await this.owePlcLog(log.did, row.as_of)
                return
            }
        }
        // A debt that arrived after this fetch began is still owed.
        const settled = row?.owed_at == null || row.owed_at <= log.asOfMs
        this.db.sql.exec(
            "INSERT INTO plc_logs (did, log, as_of, owed_at) VALUES (?1, ?2, ?3, NULL) " +
                "ON CONFLICT(did) DO UPDATE SET log = ?2, as_of = ?3, version = version + 1, " +
                "owed_at = CASE WHEN ?4 THEN NULL ELSE owed_at END, attempted_at = 0",
            log.did,
            JSON.stringify(log),
            log.asOfMs,
            settled ? 1 : 0
        )
        await this.recordDidDocument(log.did, document, log.asOfMs - FETCH_AS_OF_SKEW_MS)
    }

    async markPlcLogAttempted(did: string, attemptedAtMs: number): Promise<void> {
        this.db.sql.exec("UPDATE plc_logs SET attempted_at = ? WHERE did = ?", attemptedAtMs, did)
    }

    /** A DID that left: unpublish its log and forget any debt. */
    private dropPlcLogSync(did: string): void {
        this.db.sql.exec("DELETE FROM plc_logs WHERE did = ? AND published_version IS NULL", did)
        this.db.sql.exec(
            "UPDATE plc_logs SET log = NULL, owed_at = NULL, version = version + 1 WHERE did = ?",
            did
        )
    }

    /**
     * Publish up to `limit` logs as `plclog:<did>`: any whose version differs
     * from the published one. A DID that left has its entry removed, and its
     * row once that is done.
     */
    async publishPlcLogs(limit: number): Promise<{ published: number; remaining: number }> {
        const writer = kvPlcLogWriter(this.env)
        const due = this.db.sql
            .exec<{ did: string; log: string | null; version: number }>(
                "SELECT did, log, version FROM plc_logs " +
                    "WHERE (published_version IS NULL OR published_version != version) " +
                    "AND (log IS NOT NULL OR published_version IS NOT NULL) ORDER BY as_of LIMIT ?",
                limit
            )
            .toArray()
        let published = 0
        for (const row of due) {
            try {
                if (row.log === null) await writer.delete(row.did)
                else await writer.put(JSON.parse(row.log) as PlcLog)
            } catch (err) {
                console.warn(`monitor: plc log publish failed for ${row.did}`, err)
                continue
            }
            const marked = this.db.sql.exec(
                "UPDATE plc_logs SET published_version = ? WHERE did = ?",
                row.version,
                row.did
            ).rowsWritten
            if (marked === 0 && row.log !== null) {
                // The DID left while its log was being written: nothing else will remove it.
                await writer.delete(row.did).catch(() => {})
            }
            this.db.sql.exec(
                "DELETE FROM plc_logs WHERE did = ? AND log IS NULL AND owed_at IS NULL AND version = ?",
                row.did,
                row.version
            )
            published += 1
        }
        const remaining = this.db.sql
            .exec<{ n: number }>(
                "SELECT COUNT(*) AS n FROM plc_logs WHERE (published_version IS NULL OR published_version != version) " +
                    "AND (log IS NOT NULL OR published_version IS NOT NULL)"
            )
            .one().n
        return { published, remaining }
    }

    // ---- GraphProjectorIndex ----------------------------------------------

    async projectorCursor(): Promise<ProjectorCursor | null> {
        const stored = this.metaOf("graph_projector_cursor")
        if (stored === undefined) return null
        try {
            const cursor = JSON.parse(stored) as ProjectorCursor | null
            return cursor?.kind === "tail" || cursor?.kind === "rebuild" ? cursor : null
        } catch {
            // A corrupt cursor rebuilds rather than wedging the projector.
            return null
        }
    }

    async setProjectorCursor(cursor: ProjectorCursor): Promise<void> {
        this.setMeta("graph_projector_cursor", JSON.stringify(cursor))
    }

    async mirroredGraphStanding(did: string): Promise<MirroredGraphStanding> {
        const row = this.db.sql
            .exec<{ owner: number; inflight: number }>(
                "SELECT owner, inflight FROM graph_mirrored WHERE did = ?",
                did
            )
            .toArray()[0]
        if (row === undefined) return "not-served"
        if (row.inflight === 1) return "in-flight"
        return row.owner === 1 ? "served" : "not-served"
    }

    async servedGraphsMirrored(
        cursor: string | null,
        limit: number
    ): Promise<{ dids: string[]; cursor: string | null }> {
        const dids = this.db.sql
            .exec<{ did: string }>(
                "SELECT did FROM graph_mirrored WHERE (owner = 1 OR inflight = 1) " +
                    "AND (?1 IS NULL OR did > ?1) ORDER BY did LIMIT ?2",
                cursor,
                limit + 1
            )
            .toArray()
            .map((r) => r.did)
        const page = dids.slice(0, limit)
        return { dids: page, cursor: dids.length > limit ? page[page.length - 1]! : null }
    }

    async isGraphOwner(did: string): Promise<boolean> {
        if (this.interestPolicy() === "registered") return this.isRegistered(did)
        return this.holderStateSync(did) === "held"
    }

    async setRegistered(did: string, registered: boolean, atMs: number): Promise<void> {
        this.ctx.storage.transactionSync(() => this.setRegisteredSync(did, registered, atMs))
    }

    private setRegisteredSync(did: string, registered: boolean, atMs: number): void {
        const ownedBefore = this.ownsSync(did)
        this.db.sql.exec(
            "INSERT INTO interest (did, registered) VALUES (?1, ?2) " +
                "ON CONFLICT(did) DO UPDATE SET registered = ?2",
            did,
            registered ? 1 : 0
        )
        this.reevaluateInterest(did, atMs, ownedBefore)
    }

    async setOwnerFollowers(did: string, count: number, atMs: number): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            if (
                count === 0 &&
                this.db.sql.exec("SELECT 1 FROM interest WHERE did = ?", did).toArray().length === 0
            ) {
                return
            }
            this.db.sql.exec(
                "INSERT INTO interest (did, owner_followers) VALUES (?1, ?2) " +
                    "ON CONFLICT(did) DO UPDATE SET owner_followers = ?2",
                did,
                count
            )
            this.reevaluateInterest(did, atMs, this.ownsSync(did))
        })
    }

    async dueTransitions(limit: number): Promise<InterestTransition[]> {
        return this.db.sql
            .exec<{ did: string; change: "join" | "leave"; epoch: number }>(
                "SELECT did, change, epoch FROM interest_transitions ORDER BY rowid LIMIT ?",
                limit
            )
            .toArray()
    }

    async clearTransition(did: string, epoch: number): Promise<void> {
        this.db.sql.exec(
            "DELETE FROM interest_transitions WHERE did = ? AND epoch = ?",
            did,
            epoch
        )
    }

    async oweJoin(did: string, records: readonly WatchedRecord[], epoch: number): Promise<void> {
        if ((await this.interestEpoch(did)) !== epoch) return
        this.ctx.storage.transactionSync(() => {
            const indexed =
                this.db.sql.exec("SELECT 1 FROM revs WHERE did = ?", did).toArray().length > 0
            const deleted =
                this.db.sql.exec("SELECT 1 FROM deleted WHERE did = ?", did).toArray().length > 0
            if (!indexed && !deleted) {
                this.db.sql.exec(
                    "INSERT INTO pending (did, rev, attempts, not_before, quiet) " +
                        "VALUES (?, '', 0, 0, 1) ON CONFLICT(did) DO NOTHING",
                    did
                )
            }
            if (did.startsWith("did:plc:") && !deleted) {
                this.db.sql.exec(
                    "INSERT INTO plc_logs (did, owed_at) VALUES (?, ?) " +
                        "ON CONFLICT(did) DO UPDATE SET owed_at = COALESCE(owed_at, excluded.owed_at)",
                    did,
                    Date.now()
                )
            }
            for (const r of records) {
                this.db.sql.exec(
                    "INSERT INTO rec_pending (did, collection, rkey, rev, epoch) " +
                        "VALUES (?1, ?2, ?3, COALESCE((SELECT rev FROM records " +
                        "WHERE did = ?1 AND collection = ?2 AND rkey = ?3), ''), ?4) " +
                        "ON CONFLICT(did, collection, rkey) DO UPDATE SET epoch = ?4",
                    did,
                    r.collection,
                    r.rkey,
                    epoch
                )
            }
        })
    }

    async forgetLeft(did: string): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            for (const table of ["records", "rec_pending", "checks", "refresh_requests"]) {
                this.db.sql.exec(`DELETE FROM ${table} WHERE did = ?`, did)
            }
            this.dropPlcLogSync(did)
            if (this.interestPolicy() === "registered") {
                for (const table of ["pending", "revs", "holder_state", "deleted", "key_updates"]) {
                    this.db.sql.exec(`DELETE FROM ${table} WHERE did = ?`, did)
                }
            }
        })
    }

    // ---- SecondaryIndex ---------------------------------------------------

    async dueSecondaries(nowMs: number, limit: number): Promise<PendingRecordFetch[]> {
        return this.db.sql
            .exec<{
                did: string
                collection: string
                rkey: string
                rev: string
                attempts: number
                not_before: number
                epoch: number
            }>(
                "SELECT did, collection, rkey, rev, attempts, not_before, epoch FROM rec_pending " +
                    "WHERE not_before <= ? ORDER BY not_before LIMIT ?",
                nowMs,
                limit
            )
            .toArray()
            .map((r) => ({
                did: r.did,
                collection: r.collection,
                rkey: r.rkey,
                rev: r.rev,
                attempts: r.attempts,
                notBeforeMs: r.not_before,
                epoch: r.epoch,
            }))
    }

    async deferSecondary(ref: RecordRef, notBeforeMs: number): Promise<void> {
        this.db.sql.exec(
            "UPDATE rec_pending SET attempts = attempts + 1, not_before = ? " +
                "WHERE did = ? AND collection = ? AND rkey = ?",
            notBeforeMs,
            ref.did,
            ref.collection,
            ref.rkey
        )
    }

    async clearSecondary(ref: RecordRef, owedRev: string): Promise<void> {
        this.clearSecondarySync(ref, owedRev)
    }

    async completeSecondary(
        ref: RecordRef,
        rev: string,
        verified: VerifiedWrite,
        epoch: number,
        owedRev: string
    ): Promise<SecondaryWriteAnswer | "stored"> {
        return this.ctx.storage.transactionSync(() => {
            const refusal = this.secondaryRefusal(ref, rev, epoch)
            if (refusal !== null) return refusal
            this.db.sql.exec(
                "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) " +
                    "VALUES (?, ?, ?, ?, ?, ?) " +
                    "ON CONFLICT(did, collection, rkey) DO UPDATE SET rev = excluded.rev, " +
                    "cid = excluded.cid, verified_with = excluded.verified_with",
                ref.did,
                ref.collection,
                ref.rkey,
                rev,
                verified.cid,
                verified.verifiedWith
            )
            this.clearSecondarySync(ref, owedRev)
            return "stored" as const
        })
    }

    async disposeSecondary(
        ref: RecordRef,
        rev: string,
        epoch: number,
        owedRev: string
    ): Promise<SecondaryWriteAnswer | "disposed"> {
        return this.ctx.storage.transactionSync(() => {
            const refusal = this.secondaryRefusal(ref, rev, epoch)
            if (refusal !== null) return refusal
            this.db.sql.exec(
                "DELETE FROM records WHERE did = ? AND collection = ? AND rkey = ?",
                ref.did,
                ref.collection,
                ref.rkey
            )
            this.clearSecondarySync(ref, owedRev)
            return "disposed" as const
        })
    }

    /** `left` if the DID is out of the interest epoch it was owed under; `older` if a newer rev is indexed. */
    private secondaryRefusal(ref: RecordRef, rev: string, epoch: number): SecondaryWriteAnswer | null {
        const interest = this.db.sql
            .exec<{ member: number; epoch: number }>(
                "SELECT member, epoch FROM interest WHERE did = ?",
                ref.did
            )
            .toArray()[0]
        if (interest === undefined || interest.member !== 1 || interest.epoch !== epoch) return "left"
        const indexed = this.secondaryRevSync(ref)
        if (indexed !== null && compareRev(indexed, rev) === "regressed") return "older"
        return null
    }

    private secondaryRevSync(ref: RecordRef): string | null {
        return (
            this.db.sql
                .exec<{ rev: string }>(
                    "SELECT rev FROM records WHERE did = ? AND collection = ? AND rkey = ?",
                    ref.did,
                    ref.collection,
                    ref.rkey
                )
                .toArray()[0]?.rev ?? null
        )
    }

    /** Only while the row still owes the rev this settle read: a newer live commit survives. */
    private clearSecondarySync(ref: RecordRef, owedRev: string): void {
        this.db.sql.exec(
            "DELETE FROM rec_pending WHERE did = ? AND collection = ? AND rkey = ? AND rev = ?",
            ref.did,
            ref.collection,
            ref.rkey,
            owedRev
        )
    }

    async secondaryRevOf(ref: RecordRef): Promise<string | null> {
        return this.secondaryRevSync(ref)
    }

    async forgetSecondaries(did: string): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "DELETE FROM records WHERE did = ?1 AND NOT (collection = ?2 AND rkey = 'self')",
                did,
                this.env.MONITOR_COLLECTION
            )
            this.db.sql.exec("DELETE FROM rec_pending WHERE did = ?", did)
        })
    }

    // ---- SecondaryIntakeIndex ---------------------------------------------

    async oweSecondary(owed: OwedRecord, cursor: Cursor): Promise<SecondaryIntakeOutcome> {
        return this.ctx.storage.transactionSync(() => {
            const interest = this.db.sql
                .exec<{ member: number; epoch: number }>(
                    "SELECT member, epoch FROM interest WHERE did = ?",
                    owed.did
                )
                .toArray()[0]
            if (interest === undefined || interest.member !== 1) {
                return { outcome: "ignored" as const }
            }
            if (this.secondaryRevSync(owed) === owed.rev) {
                return { outcome: "duplicate" as const }
            }
            this.db.sql.exec(
                "INSERT INTO rec_pending (did, collection, rkey, rev, epoch) VALUES (?, ?, ?, ?, ?) " +
                    "ON CONFLICT(did, collection, rkey) DO UPDATE SET " +
                    "rev = excluded.rev, epoch = excluded.epoch",
                owed.did,
                owed.collection,
                owed.rkey,
                owed.rev,
                interest.epoch
            )
            this.raiseFollowCursor(cursor)
            return { outcome: "accepted" as const }
        })
    }

    // ---- FollowStreamIndex ------------------------------------------------

    async readFollowCursor(): Promise<Cursor | null> {
        return (
            this.db.sql
                .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'follow_cursor'")
                .toArray()[0]?.v ?? null
        )
    }

    async skipFollowEvent(cursor: Cursor): Promise<void> {
        const nowMs = Date.now()
        if (nowMs - this.followCursorPersistedAt < this.followPersistMs()) return
        this.raiseFollowCursor(cursor)
        this.followCursorPersistedAt = nowMs
    }

    /** Logged only: nothing reads `edge_ops` until the edge index exists. */
    async logEdgeOp(op: NewEdgeOp, cursor: Cursor): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "INSERT INTO edge_ops (kind, follower, rkey, subject, rev, cursor, collection) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                op.kind,
                op.follower,
                op.rkey,
                op.kind === "create" ? op.subject : null,
                op.rev,
                op.cursor,
                op.collection
            )
            this.raiseFollowCursor(cursor)
        })
    }

    async requeueListing(did: string, cursor: Cursor): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.queueListingSync(did, Date.now(), "sync")
            this.raiseFollowCursor(cursor)
        })
    }

    private followPersistMs(): number {
        return this.envInt(this.env.FOLLOW_CURSOR_PERSIST_MS, 5_000)
    }

    /**
     * Persist the follow stream's cursor, only ever raising it: a kept event
     * carrying a lower cursor than one already stored leaves it alone.
     */
    private raiseFollowCursor(cursor: Cursor): void {
        if (!/^\d+$/.test(cursor)) return
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('follow_cursor', ?1) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v " +
                "WHERE CAST(excluded.v AS INTEGER) > CAST(meta.v AS INTEGER)",
            cursor
        )
        this.followCursorPersistedAt = Date.now()
    }

    /** Stamp `last_connected_at`, at most once per cursor-persist interval. */
    private markFollowOpen(force = false): void {
        const nowMs = Date.now()
        if (!force && nowMs - this.followConnectedAt < this.followPersistMs()) return
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('last_connected_at', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            String(nowMs)
        )
        this.followConnectedAt = nowMs
    }

    // ---- ListingIndex -----------------------------------------------------
    // State: `listing_requeue` is the queue (`attempts`, `not_before`,
    // `timeouts`, `permanent_failures`, `unlistable`, and `low_priority` for a
    // `stale` row, which sorts after the other reasons); `listings` holds
    // each DID's `listed_at`, `owner_listed_at`, sticky `paged` and, while one
    // runs, the `progress_*` columns; `listing_stage` holds the rows a
    // listing read until it completes. `dropEdgeOps` deletes the staged rows
    // its batch names (a live op is newer than the snapshot). The ownership
    // hook stamps the queue row and clears `owner_listed_at` when ownership
    // is lost; progress and staging are cleared by an interest leave and by
    // `sync`, `gap` and `registration` restarts. `meta.listing_gen` is the
    // generation counter, `meta.gap_requeued_for` the `last_connected_at` a
    // gap re-queue was done for.

    /** Scans `listing_requeue` (a queue of at most a few hundred due rows beside the idle ones), so it is not indexed. */
    async dueListings(nowMs: number, limit: number): Promise<QueuedListing[]> {
        return this.db.sql
            .exec<QueueSqlRow>(
                "SELECT q.did AS did, q.attempts, q.not_before, q.timeouts, q.permanent_failures, " +
                    "COALESCE(l.paged, 0) AS paged, l.progress_kind, l.progress_gen, " +
                    "l.progress_phase, l.progress_collection, l.progress_cursor, l.progress_pds, " +
                    "l.progress_began_at, l.progress_pages " +
                    "FROM listing_requeue q LEFT JOIN listings l ON l.did = q.did " +
                    "WHERE q.unlistable = 0 AND q.not_before <= ?1 " +
                    "ORDER BY l.progress_kind IS NULL, q.low_priority, " +
                    "COALESCE(l.progress_began_at, q.queued_at), q.queued_at, q.did LIMIT ?2",
                nowMs,
                limit
            )
            .toArray()
            .map(queuedListing)
    }

    async inProgressCounts(): Promise<Record<ListingKind, number>> {
        const counts: Record<ListingKind, number> = { "owner-repo": 0, "owner-paged": 0, mutual: 0 }
        const rows = this.db.sql
            .exec<{ kind: ListingKind; n: number }>(
                "SELECT l.progress_kind AS kind, COUNT(*) AS n FROM listings l " +
                    "JOIN listing_requeue q ON q.did = l.did " +
                    "WHERE l.progress_kind IS NOT NULL AND q.unlistable = 0 " +
                    "AND (q.not_before <= ?1 OR EXISTS (SELECT 1 FROM listing_stage s WHERE s.did = l.did)) " +
                    "GROUP BY l.progress_kind",
                Date.now()
            )
            .toArray()
        for (const r of rows) counts[r.kind] = r.n
        return counts
    }

    async dueQueuedCount(nowMs: number): Promise<number> {
        return this.db.sql
            .exec<{ n: number }>(
                "SELECT COUNT(*) AS n FROM listing_requeue q " +
                    "WHERE q.unlistable = 0 AND q.not_before <= ? AND NOT EXISTS " +
                    "(SELECT 1 FROM listings l WHERE l.did = q.did AND l.progress_kind IS NOT NULL)",
                nowMs
            )
            .one().n
    }

    async beginListing(
        did: string,
        kind: ListingKind,
        nowMs: number,
        pds: string | null,
        notBeforeMs: number
    ): Promise<StartedListing> {
        return this.ctx.storage.transactionSync(() => {
            const gen = this.nextGenSync()
            const queued = this.db.sql
                .exec<{ queued_at: number }>("SELECT queued_at FROM listing_requeue WHERE did = ?", did)
                .toArray()[0]
            // A DID whose queue row is gone (it left interest) begins nothing.
            if (queued === undefined) return { gen, beganAtMs: nowMs }
            const beganAtMs = Math.max(nowMs, queued.queued_at)
            const previous = this.db.sql
                .exec<{ last_kind: string | null }>("SELECT last_kind FROM listings WHERE did = ?", did)
                .toArray()[0]?.last_kind
            if (previous !== undefined && previous !== null && previous !== kind) {
                this.db.sql.exec("UPDATE listing_requeue SET timeouts = 0 WHERE did = ?", did)
            }
            this.db.sql.exec(
                "INSERT INTO listings (did, progress_kind, progress_gen, progress_phase, " +
                    "progress_collection, progress_cursor, progress_pds, progress_began_at, " +
                    "progress_pages, last_kind) " +
                    "VALUES (?1, ?2, ?3, 'fetch', 'follow', NULL, ?4, ?5, 0, ?2) " +
                    "ON CONFLICT(did) DO UPDATE SET progress_kind = ?2, progress_gen = ?3, " +
                    "progress_phase = 'fetch', progress_collection = 'follow', progress_cursor = NULL, progress_pds = ?4, " +
                    "progress_began_at = ?5, progress_pages = 0, last_kind = ?2",
                did,
                kind,
                gen,
                pds,
                beganAtMs
            )
            this.db.sql.exec("DELETE FROM listing_stage WHERE did = ?", did)
            this.db.sql.exec(
                "UPDATE listing_requeue SET attempts = attempts + 1, not_before = ?2, low_priority = 0 " +
                    "WHERE did = ?1",
                did,
                notBeforeMs
            )
            return { gen, beganAtMs }
        })
    }

    private nextGenSync(): number {
        const gen = Number(this.metaOf("listing_gen") ?? 0) + 1
        this.setMeta("listing_gen", String(gen))
        return gen
    }

    /** Whether `did`'s stored progress is the one at `gen`. */
    private progressIsSync(did: string, gen: number): boolean {
        return (
            this.db.sql
                .exec("SELECT 1 FROM listings WHERE did = ? AND progress_gen = ?", did, gen)
                .toArray().length > 0
        )
    }

    private commitStepSync(did: string): void {
        this.db.sql.exec(
            "UPDATE listing_requeue SET attempts = 0, not_before = 0, timeouts = 0, permanent_failures = 0 " +
                "WHERE did = ?",
            did
        )
    }

    async resumeListing(did: string, gen: number, notBeforeMs: number): Promise<boolean> {
        return this.ctx.storage.transactionSync(() => {
            if (!this.progressIsSync(did, gen)) return false
            this.db.sql.exec(
                "UPDATE listing_requeue SET attempts = attempts + 1, not_before = ? WHERE did = ?",
                notBeforeMs,
                did
            )
            return true
        })
    }

    async stageRows(
        did: string,
        gen: number,
        rows: readonly StagedRow[],
        fetch: { collection: EdgeCollection; cursor: string | null },
        done: boolean
    ): Promise<boolean> {
        return this.ctx.storage.transactionSync(() => {
            if (!this.progressIsSync(did, gen)) return false
            for (const r of rows) {
                this.db.sql.exec(
                    "INSERT INTO listing_stage (did, collection, rkey, subject) VALUES (?1, ?2, ?3, ?4) " +
                        "ON CONFLICT(did, collection, rkey) DO UPDATE SET subject = ?4",
                    did,
                    r.collection,
                    r.rkey,
                    r.subject
                )
            }
            this.db.sql.exec(
                "UPDATE listings SET progress_pages = CASE WHEN COALESCE(progress_collection, 'follow') = ?2 " +
                    "THEN progress_pages + 1 ELSE 0 END " +
                    "WHERE did = ?1 AND progress_kind <> 'owner-repo'",
                did,
                fetch.collection
            )
            this.db.sql.exec(
                done
                    ? "UPDATE listings SET progress_phase = 'drain', progress_collection = ?2, " +
                          "progress_cursor = NULL WHERE did = ?1"
                    : "UPDATE listings SET progress_collection = ?2, progress_cursor = ?3 WHERE did = ?1",
                ...(done ? [did, fetch.collection] : [did, fetch.collection, fetch.cursor])
            )
            this.commitStepSync(did)
            return true
        })
    }

    async stagedRows(
        did: string,
        after: { collection: EdgeCollection; rkey: string } | null,
        limit: number
    ): Promise<StagedRow[]> {
        return this.db.sql
            .exec<{ collection: EdgeCollection; rkey: string; subject: string }>(
                "SELECT collection, rkey, subject FROM listing_stage WHERE did = ?1 AND " +
                    "(?2 IS NULL OR (collection, rkey) > (?2, ?3)) ORDER BY collection, rkey LIMIT ?4",
                did,
                after?.collection ?? null,
                after?.rkey ?? null,
                limit
            )
            .toArray()
    }

    async saveDrainProgress(
        did: string,
        gen: number,
        cursor: { collection: EdgeCollection; rkey: string },
        subjects: readonly string[]
    ): Promise<boolean> {
        return this.ctx.storage.transactionSync(() => {
            if (!this.progressIsSync(did, gen)) return false
            this.db.sql.exec(
                "UPDATE listings SET progress_collection = ?, progress_cursor = ? WHERE did = ?",
                cursor.collection,
                cursor.rkey,
                did
            )
            this.commitStepSync(did)
            this.queueRecountSync(subjects, Date.now())
            return true
        })
    }

    async switchToPaged(did: string, gen: number, nowMs: number): Promise<boolean> {
        return this.ctx.storage.transactionSync(() => {
            if (!this.progressIsSync(did, gen)) return false
            this.db.sql.exec("UPDATE listings SET paged = 1 WHERE did = ?", did)
            this.clearProgressSync(did)
            this.db.sql.exec(
                "UPDATE listing_requeue SET attempts = 0, not_before = 0, timeouts = 0, " +
                    "permanent_failures = 0, queued_at = MAX(?2, queued_at + 1) WHERE did = ?1",
                did,
                nowMs
            )
            return true
        })
    }

    private clearProgressSync(did: string): void {
        this.db.sql.exec(
            "UPDATE listings SET progress_kind = NULL, progress_gen = NULL, progress_phase = NULL, " +
                "progress_collection = NULL, progress_cursor = NULL, progress_pds = NULL, " +
                "progress_began_at = NULL, progress_pages = 0 WHERE did = ?",
            did
        )
        this.db.sql.exec("DELETE FROM listing_stage WHERE did = ?", did)
    }

    async completeListing(
        did: string,
        gen: number,
        done: { beganAtMs: number; nowMs: number; subjects: readonly string[] }
    ): Promise<boolean> {
        return this.ctx.storage.transactionSync(() => {
            const progress = this.db.sql
                .exec<{ kind: ListingKind; first: number }>(
                    "SELECT progress_kind AS kind, owner_listed_at IS NULL AS first FROM listings " +
                        "WHERE did = ? AND progress_gen = ?",
                    did,
                    gen
                )
                .toArray()[0]
            if (progress === undefined) return false
            const ownerKind = progress.kind !== "mutual"
            const owns = ownerKind && this.ownsSync(did)
            this.db.sql.exec(
                "UPDATE listings SET listed_at = ?2, owner_listed_at = CASE " +
                    "WHEN ?3 = 'mutual' THEN NULL WHEN ?4 = 1 THEN ?2 ELSE owner_listed_at END WHERE did = ?1",
                did,
                done.nowMs,
                progress.kind,
                owns ? 1 : 0
            )
            if (owns && progress.first === 1 && this.registeredSync(did)) {
                this.queueFolloweeListingsSync(did, done.nowMs)
            }
            if (ownerKind !== this.ownsSync(did)) {
                // The kind this listing ran as is no longer the DID's: keep it
                // queued so the kind is decided again.
                this.db.sql.exec(
                    "UPDATE listing_requeue SET queued_at = MAX(?2, ?3, queued_at + 1) WHERE did = ?1",
                    did,
                    done.nowMs,
                    done.beganAtMs + 1
                )
            } else {
                this.db.sql.exec(
                    "DELETE FROM listing_requeue WHERE did = ? AND queued_at <= ?",
                    did,
                    done.beganAtMs
                )
            }
            this.clearProgressSync(did)
            this.queueRecountSync(done.subjects, done.nowMs)
            return true
        })
    }

    private registeredSync(did: string): boolean {
        return (
            this.db.sql
                .exec("SELECT 1 FROM interest WHERE did = ? AND registered = 1", did)
                .toArray().length > 0
        )
    }

    /**
     * A first completed owner listing widens the mutual filter of its
     * followees that are in interest, so each is listed again, unless it
     * owns a graph (an owner listing keeps every follow already).
     */
    private queueFolloweeListingsSync(owner: string, atMs: number): void {
        // A follow whose staged row a flush already dropped is not read here,
        // which is fine: that live create queued its own followee join.
        const everyone = this.interestPolicy() === "everyone"
        const subjects = this.db.sql
            .exec<{ did: string }>(
                "SELECT DISTINCT s.subject AS did FROM listing_stage s " +
                    "JOIN interest i ON i.did = s.subject AND i.member = 1 " +
                    "LEFT JOIN holder_state h ON h.did = s.subject " +
                    "WHERE s.did = ?1 AND s.collection = 'follow' AND s.subject <> ?1 AND " +
                    (everyone ? "COALESCE(h.state, '') <> 'held'" : "i.registered = 0"),
                owner
            )
            .toArray()
        for (const { did } of subjects) this.queueListingSync(did, atMs, "registration")
    }

    async deferListing(
        did: string,
        gen: number | null,
        notBeforeMs: number,
        cause: { timedOut: boolean; permanent: boolean },
        permanentFailuresBeforeUnlistable: number
    ): Promise<"deferred" | "unlistable" | "superseded"> {
        return this.ctx.storage.transactionSync(() => {
            const row = this.db.sql
                .exec<{ kind: ListingKind | null; timeouts: number; failures: number }>(
                    "SELECT l.progress_kind AS kind, q.timeouts AS timeouts, " +
                        "q.permanent_failures AS failures FROM listing_requeue q " +
                        "LEFT JOIN listings l ON l.did = q.did WHERE q.did = ? AND " +
                        (gen === null ? "l.progress_kind IS NULL" : "l.progress_gen = ?"),
                    ...(gen === null ? [did] : [did, gen])
                )
                .toArray()[0]
            if (row === undefined) return "superseded" as const
            const failures = cause.permanent ? row.failures + 1 : 0
            const listRecords = row.kind === "owner-paged" || row.kind === "mutual"
            const timeouts = cause.timedOut ? row.timeouts + 1 : 0
            if (
                failures >= permanentFailuresBeforeUnlistable ||
                (listRecords && cause.timedOut && timeouts >= FOLLOW_TIMEOUTS_BEFORE_PAGED)
            ) {
                this.db.sql.exec("UPDATE listing_requeue SET unlistable = 1 WHERE did = ?", did)
                this.clearProgressSync(did)
                return "unlistable" as const
            }
            this.db.sql.exec(
                "UPDATE listing_requeue SET not_before = ?2, timeouts = ?3, permanent_failures = ?4 " +
                    "WHERE did = ?1",
                did,
                notBeforeMs,
                timeouts,
                failures
            )
            const staged = this.db.sql
                .exec("SELECT 1 FROM listing_stage WHERE did = ? LIMIT 1", did)
                .toArray()
            if (staged.length === 0) this.clearProgressSync(did)
            return "deferred" as const
        })
    }

    async dropListing(did: string): Promise<void> {
        this.ctx.storage.transactionSync(() => this.dropListingSync(did))
    }

    private dropListingSync(did: string): void {
        this.db.sql.exec("DELETE FROM listing_requeue WHERE did = ?", did)
        this.clearProgressSync(did)
        this.db.sql.exec("UPDATE listings SET owner_listed_at = NULL WHERE did = ?", did)
    }

    async lastListedAt(did: string): Promise<number | null> {
        return (
            this.db.sql
                .exec<{ listed_at: number | null }>("SELECT listed_at FROM listings WHERE did = ?", did)
                .toArray()[0]?.listed_at ?? null
        )
    }

    async queueListing(did: string, atMs: number, reason: ListingQueueReason): Promise<void> {
        this.ctx.storage.transactionSync(() => this.queueListingSync(did, atMs, reason))
    }

    private queueListingSync(did: string, atMs: number, reason: ListingQueueReason): void {
        const row = this.db.sql
            .exec<{ unlistable: number; began: number | null }>(
                "SELECT q.unlistable AS unlistable, l.progress_began_at AS began " +
                    "FROM listing_requeue q LEFT JOIN listings l ON l.did = q.did WHERE q.did = ?",
                did
            )
            .toArray()[0]
        if (row === undefined) {
            this.db.sql.exec(
                "INSERT INTO listing_requeue (did, queued_at, low_priority) VALUES (?, ?, ?)",
                did,
                atMs,
                reason === "stale" ? 1 : 0
            )
            return
        }
        if (row.unlistable === 1) {
            if (reason === "stale" || reason === "upgrade" || reason === "gap") return
            this.db.sql.exec(
                "UPDATE listing_requeue SET unlistable = 0, attempts = 0, not_before = 0, " +
                    "timeouts = 0, permanent_failures = 0, low_priority = 0, queued_at = ?2 WHERE did = ?1",
                did,
                atMs
            )
            return
        }
        if (reason === "sync") {
            this.db.sql.exec(
                "UPDATE listing_requeue SET timeouts = 0, permanent_failures = 0 WHERE did = ?",
                did
            )
        }
        if (reason !== "stale") {
            this.db.sql.exec("UPDATE listing_requeue SET low_priority = 0 WHERE did = ?", did)
        }
        if (row.began === null) return
        if (reason === "join" || reason === "stale" || reason === "upgrade") return
        // Forward-only: Date.now() does not advance without I/O in workerd, so
        // a same-millisecond stamp is normal and must still outrank the begin.
        this.db.sql.exec(
            "UPDATE listing_requeue SET queued_at = MAX(?2, ?3, queued_at + 1) WHERE did = ?1",
            did,
            atMs,
            row.began + 1
        )
        if (reason !== "ownership") this.clearProgressSync(did)
    }

    async queueAllListings(atMs: number, reason: "upgrade" | "gap"): Promise<number> {
        return this.ctx.storage.transactionSync(() => this.queueAllListingsSync(atMs, reason))
    }

    private queueAllListingsSync(atMs: number, reason: "upgrade" | "gap"): number {
        this.db.sql.exec(
            "INSERT INTO listing_requeue (did, queued_at) SELECT did, ? FROM interest WHERE member = 1 " +
                "ON CONFLICT(did) DO NOTHING",
            atMs
        )
        this.db.sql.exec(
            "UPDATE listing_requeue SET low_priority = 0 WHERE low_priority = 1 AND unlistable = 0 " +
                "AND did IN (SELECT did FROM interest WHERE member = 1)"
        )
        if (reason === "gap") {
            const running = this.db.sql
                .exec<{ did: string }>(
                    "SELECT l.did AS did FROM listings l JOIN listing_requeue q ON q.did = l.did " +
                        "WHERE l.progress_kind IS NOT NULL AND q.unlistable = 0"
                )
                .toArray()
            for (const { did } of running) this.queueListingSync(did, atMs, "gap")
        }
        return this.db.sql
            .exec<{ n: number }>(
                "SELECT COUNT(*) AS n FROM interest i JOIN listing_requeue q ON q.did = i.did " +
                    "WHERE i.member = 1 AND q.unlistable = 0"
            )
            .one().n
    }

    async queueStaleListings(
        listedBeforeMs: number,
        limit: number,
        atMs: number
    ): Promise<number> {
        const queuedCount = () =>
            this.db.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM listing_requeue").one().n
        return this.ctx.storage.transactionSync(() => {
            const before = queuedCount()
            this.db.sql.exec(
                "INSERT INTO listing_requeue (did, queued_at, low_priority) " +
                    "SELECT l.did, ?3, 1 FROM listings l JOIN interest i ON i.did = l.did AND i.member = 1 " +
                    "WHERE l.listed_at IS NOT NULL AND l.listed_at < ?1 AND l.progress_kind IS NULL " +
                    "AND NOT EXISTS (SELECT 1 FROM listing_requeue q WHERE q.did = l.did) " +
                    "ORDER BY l.listed_at LIMIT ?2",
                listedBeforeMs,
                limit,
                atMs
            )
            return queuedCount() - before
        })
    }

    // ---- EdgeOpsIndex -----------------------------------------------------

    async edgeOps(limit: number): Promise<EdgeOp[]> {
        return this.db.sql
            .exec<{
                seq: number
                kind: "create" | "delete"
                follower: string
                rkey: string
                subject: string | null
                rev: string
                cursor: string
                collection: EdgeCollection
            }>(
                "SELECT seq, kind, follower, rkey, subject, rev, cursor, collection FROM edge_ops " +
                    "ORDER BY seq LIMIT ?",
                limit
            )
            .toArray()
            .map((r) =>
                r.kind === "create"
                    ? {
                          seq: r.seq,
                          collection: r.collection,
                          kind: "create" as const,
                          follower: r.follower,
                          rkey: r.rkey,
                          subject: r.subject!,
                          rev: r.rev,
                          cursor: r.cursor,
                      }
                    : {
                          seq: r.seq,
                          collection: r.collection,
                          kind: "delete" as const,
                          follower: r.follower,
                          rkey: r.rkey,
                          rev: r.rev,
                          cursor: r.cursor,
                      }
            )
    }

    async dropEdgeOps(throughSeq: number, subjects: readonly string[]): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.db.sql.exec(
                "DELETE FROM listing_stage WHERE (did, collection, rkey) IN " +
                    "(SELECT follower, collection, rkey FROM edge_ops WHERE seq <= ?)",
                throughSeq
            )
            this.db.sql.exec("DELETE FROM edge_ops WHERE seq <= ?", throughSeq)
            this.queueRecountSync(subjects, Date.now())
        })
    }

    async currentGen(): Promise<number> {
        const v = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'listing_gen'")
            .toArray()[0]?.v
        return v === undefined ? 0 : Number(v)
    }

    // ---- GraphMirrorIndex -----------------------------------------------

    /**
     * Every DID's standing now, as the DO's tables have it. `owner` is the
     * served flag: ownership by policy and a completed owner listing
     * (`listings.owner_listed_at`).
     */
    private standingSql(): string {
        const owns =
            this.interestPolicy() === "registered"
                ? "COALESCE(i.registered, 0)"
                : "COALESCE(h.state = 'held', 0)"
        return (
            "SELECT c.did AS did, " +
            `CASE WHEN l.owner_listed_at IS NOT NULL AND ${owns} = 1 THEN 1 ELSE 0 END AS owner, ` +
            "COALESCE(h.state = 'held', 0) AS holder, " +
            "COALESCE(i.member, 0) AS member, COALESCE(i.registered, 0) AS registered " +
            "FROM (SELECT did FROM interest UNION SELECT did FROM holder_state " +
            "UNION SELECT did FROM graph_mirrored) c " +
            "LEFT JOIN holder_state h ON h.did = c.did " +
            "LEFT JOIN interest i ON i.did = c.did " +
            "LEFT JOIN listings l ON l.did = c.did "
        )
    }

    /**
     * Scans every DID in `interest`, `holder_state` and `graph_mirrored` on
     * each call: the same order of rows as the refresh scan, once per alarm.
     */
    async dueMirror(limit: number): Promise<GraphMirrorTransition[]> {
        const rows = this.db.sql
            .exec<MirrorSqlRow & PriorSqlRow>(
                "SELECT s.*, m.did AS m_did, m.owner AS m_owner, m.holder AS m_holder, " +
                    "m.member AS m_member, m.registered AS m_registered FROM (" +
                    this.standingSql() +
                    ") s LEFT JOIN graph_mirrored m ON m.did = s.did " +
                    "WHERE COALESCE(m.inflight, 0) = 1 OR s.owner <> COALESCE(m.owner, 0) " +
                    "OR s.holder <> COALESCE(m.holder, 0) " +
                    "OR s.member <> COALESCE(m.member, 0) OR s.registered <> COALESCE(m.registered, 0) " +
                    "ORDER BY s.did LIMIT ?",
                limit
            )
            .toArray()
        // Sent rows stay due until `markMirrored` records them, so a batch that
        // commits in D1 but is never recorded is re-sent even if the standing
        // flips back to what was last recorded.
        this.ctx.storage.transactionSync(() => {
            for (const r of rows) {
                this.db.sql.exec(
                    "INSERT INTO graph_mirrored (did, owner, holder, member, registered, inflight) " +
                        "VALUES (?, 0, 0, 0, 0, 1) ON CONFLICT (did) DO UPDATE SET inflight = 1",
                    r.did
                )
            }
        })
        return rows.map((r) => ({
            now: mirrorRow(r),
            mirrored:
                r.m_did === null
                    ? null
                    : mirrorRow({
                          did: r.m_did,
                          owner: r.m_owner,
                          holder: r.m_holder,
                          member: r.m_member,
                          registered: r.m_registered,
                      }),
        }))
    }

    async markMirrored(
        rows: readonly GraphMirrorRow[],
        prunedSubjects: readonly string[] = []
    ): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            this.queueRecountSync(prunedSubjects, Date.now())
            for (const r of rows) {
                if (!r.owner && !r.holder && !r.member && !r.registered) {
                    this.db.sql.exec("DELETE FROM graph_mirrored WHERE did = ?", r.did)
                    continue
                }
                this.db.sql.exec(
                    "INSERT INTO graph_mirrored (did, owner, holder, member, registered, inflight) " +
                        "VALUES (?1, ?2, ?3, ?4, ?5, 0) ON CONFLICT (did) DO UPDATE SET " +
                        "owner = ?2, holder = ?3, member = ?4, registered = ?5, inflight = 0",
                    r.did,
                    r.owner ? 1 : 0,
                    r.holder ? 1 : 0,
                    r.member ? 1 : 0,
                    r.registered ? 1 : 0
                )
            }
        })
    }

    async standingOf(did: string): Promise<GraphMirrorRow> {
        const found = this.db.sql
            .exec<MirrorSqlRow>(
                "SELECT * FROM (" + this.standingSql() + ") WHERE did = ?",
                did
            )
            .toArray()[0]
        return found === undefined
            ? { did, owner: false, holder: false, member: false, registered: false }
            : mirrorRow(found)
    }

    async mirroredPage(
        cursor: string | null,
        limit: number
    ): Promise<{ rows: GraphMirrorRow[]; cursor: string | null }> {
        const rows = this.db.sql
            .exec<MirrorSqlRow>(
                "SELECT * FROM graph_mirrored WHERE (?1 IS NULL OR did > ?1) ORDER BY did LIMIT ?2",
                cursor,
                limit + 1
            )
            .toArray()
        const page = rows.slice(0, limit)
        return {
            rows: page.map(mirrorRow),
            cursor: rows.length > limit ? page[page.length - 1]!.did : null,
        }
    }

    /**
     * The graph mirror, edge-log flush, re-count drain, graph projector,
     * change-log prune and the daily reconciles, sharing one D1 statement budget. Each runs
     * alone: a D1 outage costs neither the other steps nor the alarm's
     * re-arm.
     */
    private async runGraphSteps(): Promise<void> {
        const budget = statementBudget(this.envInt(this.env.GRAPH_STATEMENT_BUDGET, 1000))
        const edges = d1FollowEdgeWriter(this.env.graph!, budget)
        const blocks = d1BlockEdgeWriter(this.env.graph!, budget)
        const deps = { index: this, listings: this, edges, nowMs: () => Date.now(), budget }
        const owners = { edges, interest: this, nowMs: deps.nowMs }
        const reserve = this.listingReserve()
        for (const [name, step] of [
            [
                "graph mirror",
                () =>
                    mirrorGraph(
                        deps,
                        Math.max(
                            0,
                            Math.min(
                                this.envInt(this.env.GRAPH_MIRROR_BATCH, 50),
                                Math.floor((budget.remaining - reserve) / MIRROR_STATEMENTS_PER_DID)
                            )
                        )
                    ),
            ],
            [
                "listing re-queue",
                () =>
                    relistStale(deps, {
                        relistAfterMs: this.envInt(this.env.FOLLOW_RELIST_AFTER_MS, 604_800_000),
                        maxPerAlarm: STALE_RELIST_PER_ALARM,
                    }),
            ],
            ["listings", () => runListings(this.listingDeps(edges, budget), this.listingConfig())],
            [
                "edge flush",
                () =>
                    flushEdgeOps(
                        { ops: this, edges, blocks, budget, interest: this },
                        flushLimit(Math.floor((budget.remaining * 3) / 4))
                    ),
            ],
            [
                "recount drain",
                () => drainRecounts({ ...owners, queue: this, budget }, RECOUNT_DRAIN_BATCH),
            ],
            [
                "graph projector",
                () =>
                    runGraphProjector(
                        {
                            index: this,
                            changes: d1GraphChangeLog(this.env.graph!),
                            edges: d1FollowEdgeStore(this.env.graph!),
                            projections: kvGraphProjections(this.env),
                            budget,
                        },
                        // Each DID costs a KV write; they share the alarm's 1,000 KV
                        // operations with the DID-document publish, coverage and
                        // snapshot writes.
                        this.envInt(this.env.GRAPH_PROJECTOR_BATCH, 200)
                    ),
            ],
            [
                "graph change prune",
                () => pruneGraphChanges(deps, this.envInt(this.env.GRAPH_PRUNE_BATCH, 1000)),
            ],
            ["graph reconcile", () => this.reconcileGraph(deps)],
            [
                "owner followers reconcile",
                () => this.reconcileOwnerFollowerCounts({ ...owners, followed: this, budget }),
            ],
        ] as const) {
            try {
                await step()
            } catch (err) {
                console.error(`monitor: ${name} failed`, err)
            }
        }
    }

    private listingReserve(): number {
        return this.envInt(this.env.FOLLOW_LISTING_STATEMENT_RESERVE, 400)
    }

    private listingConfig(): FollowBackfillConfig {
        return {
            repos: this.envInt(this.env.FOLLOW_BACKFILL_REPOS, 4),
            listRecordsInProgress: LISTRECORDS_IN_PROGRESS,
            statementReserve: this.listingReserve(),
            maxFollows: this.envInt(this.env.MAX_FOLLOWS, 20_000),
            maxBlocks: this.envInt(this.env.MAX_BLOCKS, 20_000),
            maxRepoBytes: this.envInt(this.env.FOLLOW_MAX_REPO_BYTES, 33_554_432),
            maxMstNodes: DEFAULT_MAX_MST_NODES,
            pagesPerAlarm: LISTING_PAGES_PER_ALARM,
            timeoutsBeforePaged: FOLLOW_TIMEOUTS_BEFORE_PAGED,
            retryBaseMs: LISTING_RETRY_BASE_MS,
            retryMaxMs: LISTING_RETRY_MAX_MS,
            permanentFailuresBeforeUnlistable: FOLLOW_UNLISTABLE_AFTER,
        }
    }

    private listingDeps(edges: FollowBackfillDeps["edges"], budget: StatementBudget): FollowBackfillDeps {
        return {
            listings: this,
            interest: this,
            index: this,
            didDocuments: this,
            edges,
            blocks: d1BlockEdgeWriter(this.env.graph!, budget),
            budget,
            fetchRepo: (did) => this.fetchRepo(did),
            verifyRepo: (car, expected) => this.verifyRepo(car, expected),
            resolvePds: (did) => this.resolvePds(did),
            listRecords: (pds, did, collection, cursor) => this.listRecords(pds, did, collection, cursor),
            nowMs: () => Date.now(),
        }
    }

    private metaOf(k: string): string | undefined {
        return this.db.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v
    }

    private setMeta(k: string, v: string | null): void {
        if (v === null) this.db.sql.exec("DELETE FROM meta WHERE k = ?", k)
        else
            this.db.sql.exec(
                "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = ?2",
                k,
                v
            )
    }

    /** One page of the daily re-count of owner-followed DIDs; the cursor persists until a pass completes. */
    private async reconcileOwnerFollowerCounts(
        deps: Parameters<typeof reconcileOwnerFollowers>[0]
    ): Promise<void> {
        const stored = this.metaOf("owner_followers_cursor")
        const lastDone = Number(this.metaOf("owner_followers_done") ?? 0)
        if (stored === undefined && deps.nowMs() - lastDone < GRAPH_RECONCILE_INTERVAL_MS) return
        const next = await reconcileOwnerFollowers(deps, stored ?? null, OWNER_RECONCILE_BATCH)
        if (next === null) {
            this.setMeta("owner_followers_cursor", null)
            this.setMeta("owner_followers_done", String(deps.nowMs()))
        } else {
            this.setMeta("owner_followers_cursor", next)
        }
    }

    /** One page of the daily two-way reconcile; the cursor persists until a pass completes. */
    private async reconcileGraph(deps: GraphMirrorDeps & { budget: StatementBudget }): Promise<void> {
        const metaOf = (k: string) => this.metaOf(k)
        const setMeta = (k: string, v: string | null) => this.setMeta(k, v)
        const stored = metaOf("graph_reconcile_cursor")
        const lastDone = Number(metaOf("graph_reconcile_done") ?? 0)
        if (stored === undefined && deps.nowMs() - lastDone < GRAPH_RECONCILE_INTERVAL_MS) return
        let cursor: MirrorReconcileCursor | null = null
        if (stored !== undefined) {
            try {
                cursor = JSON.parse(stored) as MirrorReconcileCursor
            } catch {
                // A corrupt cursor restarts the pass rather than wedging it.
            }
        }
        const next = await reconcileGraphMirror(
            deps,
            cursor,
            Math.min(
                this.envInt(this.env.GRAPH_RECONCILE_BATCH, 25),
                Math.floor(deps.budget.remaining / (MIRROR_STATEMENTS_PER_DID + 2))
            )
        )
        if (next === null) {
            setMeta("graph_reconcile_cursor", null)
            setMeta("graph_reconcile_done", String(deps.nowMs()))
        } else {
            setMeta("graph_reconcile_cursor", JSON.stringify(next))
        }
    }

    // ---- RecountQueueIndex ------------------------------------------------

    async queueRecount(subjects: readonly string[], atMs: number): Promise<void> {
        this.ctx.storage.transactionSync(() => this.queueRecountSync(subjects, atMs))
    }

    /** Under `everyone` no count is kept, and nothing would drain the queue. */
    private queueRecountSync(subjects: readonly string[], atMs: number): void {
        if (this.interestPolicy() === "everyone") return
        // The stamp always moves forward, though the clock may not between
        // two queueings, so clearing what a drain read never drops a later one.
        for (const did of subjects) {
            this.db.sql.exec(
                "INSERT INTO recount_queue (did, queued_at) VALUES (?1, ?2) " +
                    "ON CONFLICT(did) DO UPDATE SET queued_at = MAX(excluded.queued_at, queued_at + 1)",
                did,
                atMs
            )
        }
    }

    async dueRecounts(limit: number): Promise<QueuedRecount[]> {
        return this.db.sql
            .exec<{ did: string; queued_at: number }>(
                "SELECT did, queued_at FROM recount_queue ORDER BY queued_at, did LIMIT ?",
                limit
            )
            .toArray()
            .map((r) => ({ did: r.did, queuedAt: r.queued_at }))
    }

    async clearRecounts(entries: readonly QueuedRecount[]): Promise<void> {
        this.ctx.storage.transactionSync(() => {
            for (const e of entries) {
                this.db.sql.exec(
                    "DELETE FROM recount_queue WHERE did = ? AND queued_at = ?",
                    e.did,
                    e.queuedAt
                )
            }
        })
    }

    // ---- OwnerFollowedIndex -----------------------------------------------

    async ownerFollowed(
        cursor: string | null,
        limit: number
    ): Promise<{ dids: string[]; cursor: string | null }> {
        const rows = this.db.sql
            .exec<{ did: string }>(
                "SELECT did FROM interest WHERE owner_followers > 0 AND (?1 IS NULL OR did > ?1) " +
                    "ORDER BY did LIMIT ?2",
                cursor,
                limit + 1
            )
            .toArray()
        const page = rows.slice(0, limit)
        return {
            dids: page.map((r) => r.did),
            cursor: rows.length > limit ? page[page.length - 1]!.did : null,
        }
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
     * Checks a fetched CAR against the signing key of the document fetched
     * with it. A fetch that carried no key verifies nothing, so a deployment
     * `fetchRecord` returning `signingKey: null` stores nothing. Protected so
     * a test can stand in for placeholder CARs.
     */
    protected verifyRecord(did: string, record: FetchedRecord): Promise<VerifyOutcome> {
        return this.verifyAt({ did, collection: this.env.MONITOR_COLLECTION, rkey: "self" }, record)
    }

    private verifyAt(ref: RecordRef, record: FetchedRecord): Promise<VerifyOutcome> {
        if (record.signingKey === null) return Promise.resolve({ kind: "unverifiable" })
        try {
            const outcome = verifyRecordProofOutcome(record.car, {
                did: ref.did,
                signingKey: record.signingKey,
                collection: ref.collection,
                rkey: ref.rkey,
            })
            return Promise.resolve(
                outcome.kind === "present"
                    ? { kind: "verified", key: record.signingKey, rev: outcome.rev, cid: outcome.cid }
                    : { kind: "verified-absent", key: record.signingKey, rev: outcome.rev }
            )
        } catch (err) {
            if (err instanceof RepoProofError) return Promise.resolve({ kind: "unverifiable" })
            throw err
        }
    }

    /**
     * `com.atproto.sync.getRecord` for a secondary record. Unlike the
     * declaration's fetch this has a working default: it resolves the DID
     * document fresh and reads the record at the PDS it names.
     */
    protected fetchRecordAt(ref: RecordRef): Promise<FetchedRecord> {
        return fetchRecordCar(ref.did, { collection: ref.collection, rkey: ref.rkey })
    }

    /** `verifyRecord` for a secondary record's own path. */
    protected verifyRecordAt(ref: RecordRef, record: FetchedRecord): Promise<VerifyOutcome> {
        return this.verifyAt(ref, record)
    }

    /**
     * An owner listing's `getRepo`, streamed. Has a working default over the
     * global `fetch` (`fetchRepoCar`, bounded by `FOLLOW_FETCH_TIMEOUT_MS`
     * and the repo byte cap); protected so a deployment or a test can stand
     * in.
     */
    protected fetchRepo(did: string): Promise<FetchedRepo> {
        return fetchRepoCar(did, {
            timeoutMs: this.envInt(this.env.FOLLOW_FETCH_TIMEOUT_MS, 30_000),
            maxBytes: this.envInt(this.env.FOLLOW_MAX_REPO_BYTES, 33_554_432),
        })
    }

    /**
     * Core `verifyRepoCollections` under the repo byte and MST node caps.
     * Protected so a test can stand in for placeholder CARs.
     */
    protected verifyRepo(
        car: AsyncIterable<Uint8Array>,
        expected: RepoCollectionsExpectation
    ): Promise<VerifiedCollections> {
        return verifyRepoCollections(car, expected)
    }

    /**
     * The DID's PDS from a freshly fetched document, once per `listRecords`
     * listing (mutual or paged owner). Protected so a test can stand in.
     */
    protected async resolvePds(did: string): Promise<ResolvedPds> {
        const fetchedAtMs = Date.now()
        const document = await fetchDidDocument(did, fetch)
        return {
            pds: pdsResolutionFromDocument(document).endpoint,
            didDocument: { document: document as unknown as DidDocument, fetchedAtMs },
        }
    }

    /**
     * One `listRecords` page of `did`'s follows or blocks at `pds` after rkey
     * `cursor`, for a mutual or paged owner listing (`listEdgeRecords`).
     */
    protected listRecords(
        pds: string,
        did: string,
        collection: EdgeCollection,
        cursor: string | null
    ): Promise<FollowPage> {
        return listEdgeRecords(did, collection, cursor, { pds })
    }

    /**
     * The head `rev` of the DID's repo at its PDS, with the signing key of
     * the document it was resolved through, for the refresh. Defaults to a
     * real read that also keeps that document; a subclass overrides it
     * alongside `fetchRecord` when the deployment resolves DIDs differently,
     * and must hand its own document to `recordWatchedDocument` to keep that.
     * The key must be in the form `fetchRecord` returns, since refresh
     * compares the two as strings; a `null` key counts as a mismatch.
     */
    protected fetchHeadRev(did: string): Promise<HeadRev> {
        return fetchHeadRev(did, {
            onDidDocument: async (fetched) => {
                await recordWatchedDocument({ index: this, didDocuments: this }, did, fetched)
            },
        })
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
            verify: (did, record) => this.verifyRecord(did, record),
            unverifiableRetryMs: this.envInt(this.env.REFRESH_STALE_AFTER_MS, 3_600_000),
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
            didDocuments: this,
            interest: this,
            secondaries: { dispose: (did) => this.disposeSecondaries(did) },
            nowMs: () => Date.now(),
        }
    }

    /** Every secondary snapshot and index row of `did`, for a repo found gone. */
    private async disposeSecondaries(did: string): Promise<void> {
        const store = kvSnapshotStore(this.env)
        const refs = new Map<string, RecordRef>()
        for (const r of await this.recordsOf(did)) {
            if (r.collection === this.env.MONITOR_COLLECTION && r.rkey === "self") continue
            refs.set(`${r.collection}/${r.rkey}`, r)
        }
        for (const r of monitorCollections(this.env)) {
            refs.set(`${r.collection}/${r.rkey}`, { did, ...r })
        }
        for (const r of refs.values()) {
            await store.deleteSecondary({ did, collection: r.collection, rkey: r.rkey })
        }
        await this.forgetSecondaries(did)
    }

    private secondaryDeps(): SecondaryDeps {
        return {
            index: this,
            interest: this,
            snapshot: kvSnapshotStore(this.env),
            fetchRecord: (ref) => this.fetchRecordAt(ref),
            verify: (ref, record) => this.verifyRecordAt(ref, record),
            // Owed quietly for a DID never held, which no one is waiting to hear about.
            deferToDeclaration: async (did) => {
                const held = await this.revOf(did)
                if (held === null) {
                    this.db.sql.exec(
                        "INSERT INTO pending (did, rev, attempts, not_before, quiet) " +
                            "VALUES (?, '', 0, 0, 1) ON CONFLICT(did) DO NOTHING",
                        did
                    )
                    return
                }
                await this.owe(did, held)
            },
            didDocuments: this,
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
            await this.connectFollow()
        } catch (err) {
            console.error("monitor: follow connect failed", err)
        }
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
     * itself. No request handler reads through this object (they only signal
     * it), so a wedge here can delay a write that notifies, never a read.
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
     * Open the follow/profile stream: a second Jetstream socket on
     * `collections` = the follow and block collections plus the secondaries'
     * collections, with no `dids`, from `meta.follow_cursor` (µs), or the tip
     * on first run. `meta.last_connected_at` is the last time the socket was
     * known open: written when it opens and refreshed while it stays open, at
     * the cursor-persist interval, so a long-open socket evicted later does
     * not read as an outage. Bounded like `connect`, reconnected only from the
     * alarm, and independent of the declaration socket: neither one's close
     * touches the other.
     */
    async connectFollow(): Promise<void> {
        if (this.followSocket !== null) return
        this.requeueOnGap(Date.now())
        const cursor = await this.readFollowCursor()
        const url = new URL(this.env.JETSTREAM_URL)
        const collections = [
            FOLLOW_COLLECTION_NSID,
            BLOCK_COLLECTION_NSID,
            ...new Set(monitorCollections(this.env).map((r) => r.collection)),
        ]
        url.searchParams.set("collections", collections.join(","))
        if (cursor !== null) url.searchParams.set("cursor", cursor)

        const ws = await this.upgrade(url, "jetstream follow stream")
        this.followSocket = ws
        this.markFollowOpen(true)

        ws.addEventListener("message", (event) => {
            void this.onFollowFrame(String(event.data))
        })
        const drop = () => {
            if (this.followSocket === ws) this.followSocket = null
        }
        ws.addEventListener("close", drop)
        ws.addEventListener("error", drop)
    }

    /**
     * An outage longer than Jetstream replays may have lost follows, so every
     * listing is queued again, once per outage: `gap_requeued_for` holds the
     * `last_connected_at` it was done for, which failed reconnects keep seeing.
     * Runs before a reconnect stamps a new open time, whichever caller got here.
     */
    private requeueOnGap(nowMs: number): void {
        // An open but silent socket counts as connected only as often as
        // frames refresh `last_connected_at`.
        const stored = this.metaOf("last_connected_at")
        if (stored === undefined || this.metaOf("gap_requeued_for") === stored) return
        const lookbackMs = this.envInt(this.env.JETSTREAM_LOOKBACK_MS, 129_600_000)
        if (!followGapExceeded(Number(stored), nowMs, lookbackMs)) return
        this.ctx.storage.transactionSync(() => {
            this.queueAllListingsSync(nowMs, "gap")
            this.setMeta("gap_requeued_for", stored)
        })
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
            void this.enqueuePlcFrame(String(event.data))
        })
        ws.addEventListener("close", (event) => {
            void this.onPlcClose(ws, event.reason)
        })
        ws.addEventListener("error", () => this.onPlcError(ws))
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
     * The export stream's read loop: append one frame to the chain that
     * handles them in order. Index lookups and the document sink only; the
     * owed key update is applied off the loop. A frame that fails is logged
     * and the chain carries on, but the coverage run ends: an operation the
     * stored documents never took in must not be vouched for, so the next
     * frame starts a new run and nothing is claimed until that run's row is
     * stored. The stored seq is kept.
     */
    private enqueuePlcFrame(raw: string): Promise<void> {
        const next = this.plcChain.then(async () => {
            const event = decodePlcExportFrame(raw)
            if (event === null) return
            if ((await intakePlcEvent(this, event, this, this)) === "owed") this.kickDrain()
        })
        this.plcChain = next.catch((err) => {
            console.error("monitor: plc frame failed", err)
            this.endPlcRun()
        })
        return this.plcChain
    }

    /** Stop vouching for the stream's current run; the seq stays. */
    private endPlcRun(): void {
        this.plcContinuousSinceMs = null
        this.plcRunPersisted = false
        this.plcCoveredThroughMs = null
    }

    /**
     * A stream close: drop a cursor that can never resume, then allow a
     * reconnect. A close from a socket that has since been replaced by a live
     * one is ignored.
     */
    private onPlcClose(ws: WebSocket | null, reason: string): Promise<void> {
        this.plcChain = this.plcChain
            .then(async () => {
                if (this.plcSocket !== null && this.plcSocket !== ws) return
                this.plcSocket = null
                if (plcCursorAfterClose(reason) === "reset") await this.resetPlcCursor()
            })
            .catch((err) => {
                console.error("monitor: plc close failed", err)
            })
        return this.plcChain
    }

    /** A socket error frees the slot for a reconnect, unless a newer socket holds it. */
    private onPlcError(ws: WebSocket): void {
        if (this.plcSocket === ws) this.plcSocket = null
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
            { collection: this.env.MONITOR_COLLECTION, policy: this.interestPolicy() },
            event,
            cursor ?? ""
        )
        if (decision === "reverify") this.kickDrain()
        if (decision === "ignored" && cursor !== null && cursor !== "") this.advanceIgnoredCursor(cursor)
    }

    /**
     * The follow stream's read loop. Every route is index lookups and one
     * synchronous write with the cursor; nothing is awaited on the network.
     */
    private async onFollowFrame(raw: string): Promise<void> {
        try {
            this.markFollowOpen()
            const event = decodeEvent(raw)
            if (event === null) return
            const cursor =
                event.timeMs === null
                    ? await this.readFollowCursor()
                    : String(Math.round(event.timeMs * 1000))
            await routeFollowEvent(
                { index: this, secondaries: monitorCollections(this.env) },
                event,
                cursor ?? ""
            )
        } catch (err) {
            console.error("monitor: follow frame failed", err)
        }
    }

    private cursorAdvancedAt = 0

    /**
     * An ignored event is still accounted for, or a resume would replay every
     * one of them. Written at most once per `IGNORED_CURSOR_PERSIST_MS`, and
     * only ever raised, so it can neither cost a write per event nor move the
     * cursor behind an event already accepted. Frames are handled without
     * awaiting one another, so this relies on the stored cursor's own guard.
     */
    private advanceIgnoredCursor(cursor: string): void {
        const nowMs = Date.now()
        if (nowMs - this.cursorAdvancedAt < IGNORED_CURSOR_PERSIST_MS) return
        const stored = this.db.sql
            .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'cursor'")
            .toArray()[0]
        try {
            if (stored !== undefined && BigInt(stored.v) >= BigInt(cursor)) return
        } catch {
            return
        }
        this.db.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('cursor', ?) " +
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            cursor
        )
        this.cursorAdvancedAt = nowMs
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
            try {
                await this.connectFollow()
            } catch (err) {
                console.error("monitor: follow connect failed", err)
            }
            // Ahead of the sweep, which throws when its relay is down and
            // would otherwise strand owed key updates behind it.
            await this.drainKeys()
            try {
                this.persistPlcCursor()
            } catch (err) {
                console.error("monitor: plc cursor persist failed", err)
            }
            // Before the documents are published, so a document a fetched log
            // confirms goes out in the same alarm.
            try {
                await drainPlcLogs(
                    {
                        index: this,
                        fetchAuditLog: (did) => fetchPlcAuditLog(did, fetch),
                        nowMs: () => Date.now(),
                    },
                    this.envInt(this.env.PLC_LOG_DRAIN_BATCH, 20)
                )
                const published = await this.publishPlcLogs(PLC_LOG_PUBLISH_BATCH)
                if (published.published > 0 || published.remaining > 0) {
                    console.log("monitor: plc logs", published)
                }
            } catch (err) {
                console.error("monitor: plc log drain failed", err)
            }
            // Ahead of the sweep, which throws when its relay is down: stored
            // documents and the coverage marker must not wait behind it.
            let coveredThroughMs: number | null = null
            try {
                const published = await this.publishDidDocuments(DID_DOCUMENT_PUBLISH_BATCH)
                coveredThroughMs = published.coveredThroughMs
                console.log("monitor: did documents", published)
            } catch (err) {
                console.error("monitor: did document publish failed", err)
            }
            try {
                await this.publishPlcCoverage(coveredThroughMs)
            } catch (err) {
                console.error("monitor: plc coverage publish failed", err)
            }
            // Joins and leaves are applied ahead of the settles; each step
            // fails alone so a directory outage cannot strand them.
            for (const [name, step] of [
                ["unregisters", () => this.applyExpiredUnregisters(Date.now())],
                ["registration reconcile", () => this.reconcileRegistrations(Date.now())],
                ["registered leaves", () => this.queueRegisteredLeaves()],
                [
                    "interest transitions",
                    () =>
                        applyInterestTransitions(
                            {
                                interest: this,
                                index: this,
                                snapshot: kvSnapshotStore(this.env),
                                secondaries: monitorCollections(this.env),
                                didDocuments: this,
                                nowMs: () => Date.now(),
                            },
                            this.envInt(this.env.INTEREST_BATCH, 64)
                        ),
                ],
            ] as const) {
                try {
                    await step()
                } catch (err) {
                    console.error(`monitor: ${name} failed`, err)
                }
            }
            // Before settling, so a DID this sweep just discovered is
            // eligible for the same tick's settle pass rather than
            // waiting a full watchdog interval — `SETTLE_BATCH` still
            // caps how much of it actually gets fetched this tick either
            // way, so a large page cannot turn into an unbounded fetch
            // burst.
            if (this.interestPolicy() === "everyone") {
                try {
                    await sweepBackfill({
                        index: this,
                        listRepos: (cursor) =>
                            listReposByCollection(cursor, {
                                relayUrl: this.env.BACKFILL_RELAY_URL,
                                collection: this.env.MONITOR_COLLECTION,
                                limit: this.envInt(this.env.BACKFILL_BATCH, 100),
                            }),
                    })
                } catch (err) {
                    console.error("monitor: backfill sweep failed", err)
                }
            }
            const batch = Number.parseInt(this.env.SETTLE_BATCH, 10)
            await settleDue(this.deps(), Number.isFinite(batch) ? batch : 32)
            try {
                await settleSecondaryDue(
                    this.secondaryDeps(),
                    Number.isFinite(batch) ? batch : 32
                )
            } catch (err) {
                console.error("monitor: secondary settle failed", err)
            }
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
                        secondary: {
                            deps: this.secondaryDeps(),
                            records: monitorCollections(this.env),
                        },
                    },
                    {
                        nowMs: Date.now(),
                        staleAfterMs: this.envInt(this.env.REFRESH_STALE_AFTER_MS, 3_600_000),
                        nonHolderStaleAfterMs: this.envInt(
                            this.env.REFRESH_NONHOLDER_STALE_AFTER_MS,
                            86_400_000
                        ),
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
            try {
                await this.runGraphSteps()
            } catch (err) {
                console.error("monitor: graph steps failed", err)
            }
            const interval = Number.parseInt(this.env.WATCHDOG_INTERVAL_MS, 10)
            if (Number.isFinite(interval) && interval > 0) {
                await this.db.setAlarm(Date.now() + interval)
            }
        }
    }
}
