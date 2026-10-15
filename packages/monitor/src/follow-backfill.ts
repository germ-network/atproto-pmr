/**
 * Follow listings: how the edge index learns a DID's follows in full, where
 * the live stream only carries changes.
 *
 * - An **owner listing** reads a graph owner's whole repo
 *   (`com.atproto.sync.getRepo`), verified once under its signing key, and
 *   keeps every follow. A repo past the walk's byte, node or record caps, or
 *   one that keeps timing out, is listed instead by the **paged owner
 *   listing**: `listRecords` pages, every follow kept, unverified.
 * - A **mutual listing** pages `com.atproto.repo.listRecords` for a DID in
 *   interest that owns no graph, and keeps only follows of registered DIDs:
 *   hints that a registered user's followee follows them back.
 *
 * Which kind runs is decided each time a listing runs, from the DID's
 * standing then. Every listing takes a fresh generation from the single
 * writer's counter at its start, reads its follows into the single writer's
 * staging table, then writes them to D1 in chunks across alarms within a
 * fixed statement reserve, and after the last chunk sweeps whatever older
 * generations had that this one does not. Its generation and cursor live in
 * its listing row. Live ops are applied by the flush at the counter's current
 * value, never below a running listing's generation, so they survive its
 * sweep; a flushed delete also removes the staged row it names, so a later
 * chunk cannot write it back.
 *
 * getRepo owner rows are verified; paged owner, mutual-hint and live rows are
 * not. All edges are hints a device verifies for itself.
 */
import {
    BodyTooLargeError,
    FetchTimeoutError,
    RecordNotFoundError,
    RepoCollectionError,
    type RepoCollectionExpectation,
    type VerifiedCollection,
} from "@germ-network/atproto-pmr-core"
import { FOLLOW_COLLECTION_NSID } from "./follow-stream"
import type { FetchedDidDocument } from "./ingest"
import {
    D1_ROWS_PER_STATEMENT,
    type DidDocumentSink,
    type FollowEdgeWriter,
    type InterestIndex,
    type MonitorIndex,
    type StatementBudget,
} from "./storage"

/**
 * How a listing reads its DID's follows, decided each time it runs from the
 * DID's standing then. A step whose kind differs from the stored progress
 * starts over: a new generation, the staging emptied.
 */
export type ListingKind =
    /** A graph owner's repo, one verified getRepo. */
    | "owner-repo"
    /** A graph owner too large for getRepo: `listRecords` pages, every follow, unverified. */
    | "owner-paged"
    /** A non-owner in interest: `listRecords` pages, follows of registered DIDs only. */
    | "mutual"

/**
 * A listing part way through. Every kind reads its follows into the single
 * writer's staging table first (`fetch`), then writes the staged rows to D1
 * in chunks across alarms (`drain`), sweeping older generations after the
 * last chunk. getRepo fetches in one step; `listRecords` kinds may take
 * several alarms of pages.
 */
export interface ListingProgress {
    kind: ListingKind
    gen: number
    phase: "fetch" | "drain"
    /**
     * `fetch`: the last rkey of the last raw `listRecords` page read (null
     * before the first). `drain`: the last staged rkey written (null before
     * the first chunk).
     */
    cursor: string | null
    /** The PDS a `listRecords` listing resolved once at its start; null for getRepo. */
    pds: string | null
    beganAtMs: number
    /**
     * Raw `listRecords` pages staged during `fetch`; 0 for getRepo and at
     * begin. Bounds the mutual listing across alarms.
     */
    pages: number
}

/** A listing waiting to run, or one part way through. */
export interface QueuedListing {
    did: string
    /**
     * Steps begun since the last committed one. Bumped before each fetch or
     * chunk, together with a provisional `notBeforeMs`, so a step that dies
     * mid-await is not due again at once and still backs off; reset (and the
     * provisional time cleared) when a step commits.
     */
    attempts: number
    notBeforeMs: number
    /**
     * Consecutive getRepo timeouts and `listRecords` fetch-phase failures
     * (both reach `deferListing` as `timedOut`); reset by any other outcome,
     * and when a listing begins with a different kind than the previous one.
     */
    timeouts: number
    /**
     * Consecutive permanent-class failures (a repo-level terminal answer,
     * an unverifiable repo, an unresolvable PDS); reset by a committed step.
     */
    permanentFailures: number
    /** The DID is listed by pages rather than getRepo (sticky once switched). */
    paged: boolean
    inProgress: ListingProgress | null
}

/** What `beginListing` fixed before the fetch. */
export interface StartedListing {
    /** The generation this listing writes at; older rows of the DID are swept after. */
    gen: number
    /** A re-queue stamped after this survives the listing's completion. */
    beganAtMs: number
}

/**
 * Why a DID is queued. A listing already in progress is left alone by
 * `join`, `stale` and `upgrade`. `ownership` keeps it running but stamps its
 * queue row past its begin (forward-only, `MAX(now, began + 1, queued_at +
 * 1)`), so its completion keeps the row and the kind is decided again.
 * `sync`, `gap` and `registration` restart it (progress and staging cleared,
 * a fresh forward-only stamp), since what it already read may predate the
 * cause. No reason resets `attempts` or `not_before` of a row already
 * queued. An `unlistable` DID is revived (attempts and failure counts
 * reset) only by `sync` (a `#sync` or `#account` reactivation), `join`,
 * `ownership` or `registration`; `stale`, `upgrade` and `gap` skip it.
 */
export type ListingQueueReason =
    /** The DID joined interest. */
    | "join"
    /** The DID started or stopped owning a graph. */
    | "ownership"
    /** Its last listing is older than the re-list interval. */
    | "stale"
    /** The one-time seed on upgrade. */
    | "upgrade"
    /** A `#sync` or reactivation from the follow stream. */
    | "sync"
    /** The follow stream was down past the lookback. */
    | "gap"
    /** A followee of a newly served owner: its mutual filter now keeps more. */
    | "registration"

/**
 * The single writer's listing queue, staging table and per-DID listing
 * state. Every method that writes a listing's progress takes its generation
 * and does nothing (returning false) when the stored progress has another,
 * so a step that raced a restart or a leave cannot publish into it.
 */
export interface ListingIndex {
    /**
     * Up to `limit` due listings: those in progress first (oldest begun
     * first), then queued ones, `stale` re-lists after every other reason.
     * Whether a queued one may begin is `runListings`' call, against
     * `inProgressCounts`. An `unlistable` DID is never due.
     */
    dueListings(nowMs: number, limit: number): Promise<QueuedListing[]>
    /**
     * Listings in progress by kind that hold a slot: due ones, and deferred
     * ones that hold staged rows. A deferred listing with nothing staged
     * holds none, so failing DIDs cannot fill the caps; staged rows exist
     * only after a successful fetch, so a deferred holder is waiting on a
     * D1 failure, not on its DID.
     */
    inProgressCounts(): Promise<Record<ListingKind, number>>
    /** Queued listings due now and not in progress (the stale re-queue tops this up). */
    dueQueuedCount(nowMs: number): Promise<number>
    /**
     * Start a listing of `kind`: bump the attempts, set the provisional
     * `notBeforeMs`, take a new generation from the single writer's counter
     * (the one the flush writes at), empty the DID's staging and store the
     * progress, all in one step and before the fetch.
     */
    beginListing(
        did: string,
        kind: ListingKind,
        nowMs: number,
        pds: string | null,
        notBeforeMs: number
    ): Promise<StartedListing>
    /**
     * Bump the attempts and set the provisional `notBeforeMs` before a later
     * step of a listing in progress. The PDS of a `listRecords` listing is
     * resolved before `beginListing`; a failed resolve defers without
     * beginning.
     */
    resumeListing(did: string, gen: number, notBeforeMs: number): Promise<boolean>
    /**
     * Append fetched rows to the DID's staging and reset the attempts.
     * Clears the provisional `notBeforeMs`. `fetchCursor` is the raw page's
     * last rkey; a `listRecords` listing's `pages` goes up by one per call.
     * `done` moves the listing to `drain` (getRepo always passes true).
     */
    stageRows(
        did: string,
        gen: number,
        rows: readonly FollowRecord[],
        fetchCursor: string | null,
        done: boolean
    ): Promise<boolean>
    /** Up to `limit` staged rows of `did` after rkey `after`, in rkey order. */
    stagedRows(did: string, after: string | null, limit: number): Promise<FollowRecord[]>
    /**
     * After a chunk's batch committed: store the last staged rkey written,
     * reset the attempts, clear the provisional `notBeforeMs` and queue the chunk's subjects for re-count, in one
     * step.
     */
    saveDrainProgress(
        did: string,
        gen: number,
        cursor: string,
        subjects: readonly string[]
    ): Promise<boolean>
    /**
     * The repo is too large for getRepo (byte, node or record cap, or
     * repeated timeouts): list it by pages from now on, starting at once.
     * Clears the progress and staging. Gen-guarded like the progress writes.
     */
    switchToPaged(did: string, gen: number, nowMs: number): Promise<boolean>
    /**
     * The last chunk and the sweep committed. In one step:
     * - drop the queue row only if it was queued at or before `beganAtMs`
     *   (a re-queue that arrived meanwhile stays);
     * - stamp `listed_at`. For an owner kind, stamp `owner_listed_at` only if
     *   the DID owns a graph in this same step; that stamp is what makes the
     *   graph served (its mirror standing's `owner` needs both ownership and
     *   the stamp, so the next mirror writes `served-add`). A mutual
     *   completion clears it;
     * - on an owner's first completion (no `owner_listed_at` before) by a
     *   registered DID, queue `registration` re-lists for the staged
     *   subjects that are in interest and own no graph (an owner listing
     *   keeps every follow already, and only a registered DID widens a
     *   mutual filter);
     * - clear the progress and staging;
     * - queue `subjects` (the sweep's) for re-count.
     */
    completeListing(
        did: string,
        gen: number,
        done: { beganAtMs: number; nowMs: number; subjects: readonly string[] }
    ): Promise<boolean>
    /**
     * A failed step: retry at `notBeforeMs` (replacing the provisional one),
     * counting a timeout (a getRepo timeout or a `listRecords` fetch-phase
     * failure) or a permanent-class failure. A failure with nothing staged also clears
     * the progress. At the `permanentFailuresBeforeUnlistable`-th
     * consecutive permanent-class failure the DID becomes `unlistable`
     * instead: progress and staging cleared, previous edges kept, no retry
     * until a `sync`, `join`, `ownership` or `registration` queue clears
     * it. Gen-guarded; `gen` is null for a listing that failed before it
     * began (its PDS did not resolve), which applies only while none is in
     * progress.
     */
    deferListing(
        did: string,
        gen: number | null,
        notBeforeMs: number,
        cause: { timedOut: boolean; permanent: boolean },
        permanentFailuresBeforeUnlistable: number
    ): Promise<"deferred" | "unlistable" | "superseded">
    /**
     * The DID is no longer in interest: drop its queue row, progress,
     * staging and `owner_listed_at`. (The interest leave clears the same
     * state when it is applied.)
     */
    dropListing(did: string): Promise<void>
    /** When `did` was last listed, or null if never. */
    lastListedAt(did: string): Promise<number | null>
    queueListing(did: string, atMs: number, reason: ListingQueueReason): Promise<void>
    /**
     * Queue every graph owner's and every other interest DID's listing;
     * returns how many interest DIDs are now queued and not unlistable.
     */
    queueAllListings(atMs: number, reason: "upgrade" | "gap"): Promise<number>
    /**
     * Queue up to `limit` listings last run before `listedBeforeMs`, skipping
     * DIDs already queued or in progress; returns how many.
     */
    queueStaleListings(listedBeforeMs: number, limit: number, atMs: number): Promise<number>
}

/** A getRepo CAR, as a stream, with the document it was resolved through. */
export interface FetchedRepo {
    car: AsyncIterable<Uint8Array>
    /**
     * The `#atproto` key of that same document, which the repo is verified
     * under; null when it has none, and then the repo is unverifiable.
     */
    signingKey: string | null
    /** The PDS it came from. */
    source: string
    didDocument: FetchedDidDocument
}

/** A DID's PDS, with the document it was read from. */
export interface ResolvedPds {
    pds: string
    didDocument: FetchedDidDocument
}

/** One follow record from a `listRecords` page. */
export interface FollowRecord {
    rkey: string
    subject: string
}

/** One raw `listRecords` page: the follows kept and where the next page starts. */
export interface FollowPage {
    records: FollowRecord[]
    /**
     * The last rkey of the raw page, malformed records included; null only
     * when the raw page was empty, which is the end. A page whose records
     * were all malformed is not the end.
     */
    lastRkey: string | null
}

export interface FollowBackfillDeps {
    listings: ListingIndex
    interest: Pick<InterestIndex, "isGraphOwner" | "inInterest" | "isRegistered">
    /** Decides whether a listing's fetched document is kept (`recordWatchedDocument`). */
    index: Pick<MonitorIndex, "isWatched">
    /** Where a listing's fetched document goes; unset, none is kept. */
    didDocuments?: DidDocumentSink
    edges: FollowEdgeWriter
    /** The alarm's shared budget; listings take at most `statementReserve` of it. */
    budget: StatementBudget
    fetchRepo(did: string): Promise<FetchedRepo>
    /** Core `verifyRepoCollection`; a seam so tests can stand in placeholder CARs. */
    verifyRepo(
        car: AsyncIterable<Uint8Array>,
        expected: RepoCollectionExpectation
    ): Promise<VerifiedCollection>
    /** The DID's PDS from a fresh document; called once per `listRecords` listing. */
    resolvePds(did: string): Promise<ResolvedPds>
    /** One `listRecords` page of `did`'s follows at `pds`, ascending, after rkey `cursor`. */
    listFollows(pds: string, did: string, cursor: string | null): Promise<FollowPage>
    nowMs(): number
}

export interface FollowBackfillConfig {
    /**
     * getRepo listings fetched per alarm, one at a time, and the most in
     * progress at once, deferred included (`FOLLOW_BACKFILL_REPOS`). It
     * bounds the walk's memory and staging, and does not limit `listRecords`
     * listings.
     */
    repos: number
    /**
     * `listRecords` listings (mutual and paged owner) in progress at once,
     * deferred included; at most one of them a paged owner, whose staging is
     * not capped by `maxFollows`.
     */
    listRecordsInProgress: number
    /** D1 statements the listings may take per alarm (`FOLLOW_LISTING_STATEMENT_RESERVE`). */
    statementReserve: number
    /**
     * Records the verifying walk holds before it refuses, switching the owner
     * to pages (`MAX_FOLLOWS`); also the mutual listing's cap, past which it
     * stops and keeps what it has.
     */
    maxFollows: number
    /** CAR bytes past which an owner is listed by pages, not getRepo (`FOLLOW_MAX_REPO_BYTES`). */
    maxRepoBytes: number
    maxMstNodes: number
    /** `listRecords` pages all listings together take per alarm. */
    pagesPerAlarm: number
    /** Consecutive getRepo timeouts after which an owner is listed by pages. */
    timeoutsBeforePaged: number
    /** First retry delay after a failed step; doubles per attempt. */
    retryBaseMs: number
    /** The longest retry delay (24 h). */
    retryMaxMs: number
    /** Consecutive permanent-class failures after which a DID is `unlistable`. */
    permanentFailuresBeforeUnlistable: number
}

export type ListingOutcome =
    /** The last chunk and the sweep committed. */
    | "listed"
    /** A step committed and the listing resumes next alarm. */
    | "in-progress"
    /** A walk cap or repeated timeouts under getRepo: switched to the paged listing. */
    | "switched-to-paged"
    /** The repo did not verify: previous edges kept, retried with backoff. */
    | "unverifiable"
    /**
     * Repeated permanent-class failures: previous edges kept, no retry until
     * a new event for the DID re-queues it.
     */
    | "unlistable"
    /** A fetch or write failed: previous edges kept, retried with backoff. */
    | "failed"
    /** No chunk fits what is left of the reserve, or no pages are left this alarm; left as is. */
    | "over-budget"
    /** No longer in interest: dropped. */
    | "not-in-interest"
    /** Its progress was restarted or cleared while the step ran; nothing published. */
    | "superseded"

const PUT_STATEMENTS_PER_CHUNK = 4
const PUT_FIXED_STATEMENTS = 1
const SWEEP_STATEMENTS = 3
const PAGE_SIZE = 100

/**
 * D1 statements draining `edges` staged rows of one follower may need at
 * worst, plus the sweep when `withSweep`. A drain step starts only if this,
 * for its chunk, fits the reserve that is left.
 */
export function worstCaseDrainStatements(edges: number, withSweep: boolean): number {
    const put =
        edges === 0
            ? 0
            : PUT_STATEMENTS_PER_CHUNK * Math.ceil(edges / D1_ROWS_PER_STATEMENT) +
              PUT_FIXED_STATEMENTS
    return put + (withSweep ? SWEEP_STATEMENTS : 0)
}

/** The largest chunk whose worst case, with the sweep, fits `statements`; 0 if none. */
export function drainChunkEdges(statements: number): number {
    const chunks = Math.floor(
        (statements - PUT_FIXED_STATEMENTS - SWEEP_STATEMENTS) / PUT_STATEMENTS_PER_CHUNK
    )
    return Math.max(0, chunks) * D1_ROWS_PER_STATEMENT
}

/** The largest chunk whose worst case, without the sweep, fits `statements`. */
function chunkEdgesWithoutSweep(statements: number): number {
    const chunks = Math.floor((statements - PUT_FIXED_STATEMENTS) / PUT_STATEMENTS_PER_CHUNK)
    return Math.max(0, chunks) * D1_ROWS_PER_STATEMENT
}

/** A step's remaining statements: its own allowance and the alarm's reserve, whichever is less. */
function allowanceOf(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    reserveStart: number,
    allowance: number
): () => number {
    const start = deps.budget.remaining
    return () => {
        const ownLeft = allowance - (start - deps.budget.remaining)
        const reserveLeft = config.statementReserve - (reserveStart - deps.budget.remaining)
        return Math.max(0, Math.min(ownLeft, reserveLeft, deps.budget.remaining))
    }
}

function isCapError(error: unknown): boolean {
    return (
        error instanceof BodyTooLargeError ||
        (error instanceof RepoCollectionError &&
            (error.code === "byte-cap-exceeded" ||
                error.code === "node-cap-exceeded" ||
                error.code === "record-cap-exceeded"))
    )
}

function isPermanent(error: unknown): boolean {
    if (error instanceof RecordNotFoundError) return error.reason !== "RecordNotFound"
    return error instanceof RepoCollectionError && !isCapError(error)
}

function retryDelayMs(config: FollowBackfillConfig, attempts: number): number {
    return Math.min(config.retryBaseMs * 2 ** (Math.max(attempts, 1) - 1), config.retryMaxMs)
}

async function deferStep(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing,
    gen: number | null,
    cause: { timedOut: boolean; permanent: boolean },
    failed: ListingOutcome = "failed"
): Promise<ListingOutcome> {
    const notBeforeMs = deps.nowMs() + retryDelayMs(config, listing.attempts)
    const result = await deps.listings.deferListing(
        listing.did,
        gen,
        notBeforeMs,
        cause,
        config.permanentFailuresBeforeUnlistable
    )
    if (result === "superseded") return "superseded"
    if (result === "unlistable") return "unlistable"
    return failed
}

async function switchToPaged(
    deps: FollowBackfillDeps,
    listing: QueuedListing,
    gen: number
): Promise<ListingOutcome> {
    if (!(await deps.listings.switchToPaged(listing.did, gen, deps.nowMs()))) {
        return "superseded"
    }
    listing.paged = true
    listing.inProgress = null
    listing.timeouts = 0
    return "switched-to-paged"
}

/** When a step that begins now is due again if it dies before committing or deferring. */
function provisionalNotBefore(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing
): number {
    return deps.nowMs() + retryDelayMs(config, listing.attempts + 1)
}

function progressOf(
    kind: ListingKind,
    started: StartedListing,
    pds: string | null
): ListingProgress {
    return {
        kind,
        gen: started.gen,
        phase: "fetch",
        cursor: null,
        pds,
        beganAtMs: started.beganAtMs,
        pages: 0,
    }
}

/**
 * Advance due listings one at a time (never concurrently: each getRepo walk
 * may hold up to the byte cap): at most `config.repos` getRepo fetches, and
 * `listRecords` listings while `config.pagesPerAlarm` pages and the reserve
 * last. A queued listing begins only below its kind's in-progress cap. The
 * reserve is shared fairly: each draining listing first gets at most
 * reserve / count, then the remainder goes oldest first, so a large drain
 * cannot keep a new owner listing from beginning. The kind is decided per
 * DID from its standing now; a DID out of interest is dropped. Returns how
 * each ended.
 */
export async function runListings(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig
): Promise<ListingOutcome[]> {
    const reserveStart = deps.budget.remaining
    const dueLimit = 2 * (config.repos + config.listRecordsInProgress)
    const due = await deps.listings.dueListings(deps.nowMs(), dueLimit)
    const counts = { ...(await deps.listings.inProgressCounts()) }
    const outcomes: ListingOutcome[] = []
    const index = new Map<string, number>()
    const record = (did: string, outcome: ListingOutcome): void => {
        const at = index.get(did)
        if (at === undefined) {
            index.set(did, outcomes.length)
            outcomes.push(outcome)
        } else {
            outcomes[at] = outcome
        }
    }

    const plan: { listing: QueuedListing; kind: ListingKind }[] = []
    for (const listing of due) {
        if (!(await deps.interest.inInterest(listing.did))) {
            await deps.listings.dropListing(listing.did)
            record(listing.did, "not-in-interest")
            continue
        }
        const kind = await kindOf(deps, listing)
        const held = listing.inProgress?.kind
        if (held !== kind) {
            if (!hasRoom(config, counts, kind)) continue
            if (held !== undefined) counts[held] = Math.max(0, counts[held] - 1)
            counts[kind] += 1
        }
        plan.push({ listing, kind })
    }

    const slots = Math.max(1, Math.floor(config.statementReserve / worstCaseDrainStatements(1, true)))
    const share = Math.max(
        Math.floor(config.statementReserve / Math.max(1, plan.length)),
        worstCaseDrainStatements(1, true)
    )
    let fetches = 0
    let pagesLeft = config.pagesPerAlarm
    const drained: string[] = []
    for (const [position, { listing, kind }] of plan.entries()) {
        const left = allowanceOf(deps, config, reserveStart, position < slots ? share : 0)
        let outcome: ListingOutcome
        try {
            const progress = listing.inProgress
            if (progress !== null && progress.kind === kind && progress.phase === "drain") {
                outcome = await resumeDrain(deps, config, listing, left)
            } else if (kind === "owner-repo") {
                if (fetches >= config.repos) {
                    record(listing.did, "over-budget")
                    continue
                }
                fetches += 1
                outcome = await listOwner(deps, config, listing)
                if (outcome === "in-progress") {
                    outcome = await drainListing(deps, config, listing, left)
                }
            } else {
                if (pagesLeft <= 0) {
                    record(listing.did, "over-budget")
                    continue
                }
                const fetched = await fetchListingPages(deps, config, listing, kind, pagesLeft)
                pagesLeft -= fetched.pagesUsed
                outcome = fetched.outcome
                if (outcome === "in-progress" && listing.inProgress?.phase === "drain") {
                    outcome = await drainListing(deps, config, listing, left)
                }
            }
        } catch {
            // A throw from the single writer's own storage before a step was
            // recorded: the step stays due and is retried next alarm.
            outcome = "failed"
        }
        record(listing.did, outcome)
        if (outcome === "in-progress" || outcome === "over-budget") {
            if (listing.inProgress?.phase === "drain") drained.push(listing.did)
        }
    }

    if (drained.length > 0 && config.statementReserve - (reserveStart - deps.budget.remaining) > 0) {
        const again = await deps.listings.dueListings(deps.nowMs(), dueLimit)
        for (const listing of again) {
            if (!drained.includes(listing.did)) continue
            if (listing.inProgress?.phase !== "drain") continue
            const left = allowanceOf(deps, config, reserveStart, Infinity)
            if (left() < worstCaseDrainStatements(1, false)) break
            try {
                record(listing.did, await resumeDrain(deps, config, listing, left))
            } catch {
                record(listing.did, "failed")
            }
        }
    }
    return outcomes
}

async function kindOf(deps: FollowBackfillDeps, listing: QueuedListing): Promise<ListingKind> {
    if (!(await deps.interest.isGraphOwner(listing.did))) return "mutual"
    return listing.paged ? "owner-paged" : "owner-repo"
}

function hasRoom(
    config: FollowBackfillConfig,
    counts: Record<ListingKind, number>,
    kind: ListingKind
): boolean {
    if (kind === "owner-repo") return counts["owner-repo"] < config.repos
    if (counts["owner-paged"] + counts.mutual >= config.listRecordsInProgress) return false
    return kind !== "owner-paged" || counts["owner-paged"] < 1
}

async function resumeDrain(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing,
    left: () => number
): Promise<ListingOutcome> {
    const progress = listing.inProgress
    if (progress === null) return "superseded"
    if (left() < worstCaseDrainStatements(1, false)) return "over-budget"
    const resumed = await deps.listings.resumeListing(
        listing.did,
        progress.gen,
        provisionalNotBefore(deps, config, listing)
    )
    if (!resumed) return "superseded"
    listing.attempts += 1
    return drainListing(deps, config, listing, left)
}

/**
 * Fetch a graph owner's repo, verify it once under the key of the document
 * fetched with it, and stage every follow. A byte, node or record cap
 * (`RepoCollectionError` `byte-cap-exceeded`, `node-cap-exceeded`,
 * `record-cap-exceeded`) stages nothing and switches the owner to pages; so
 * does the `timeoutsBeforePaged`-th consecutive timeout. Draining is
 * `drainListing`'s.
 */
export async function listOwner(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing
): Promise<ListingOutcome> {
    const did = listing.did
    const started = await deps.listings.beginListing(
        did,
        "owner-repo",
        deps.nowMs(),
        null,
        provisionalNotBefore(deps, config, listing)
    )
    const gen = started.gen
    listing.attempts += 1
    listing.inProgress = progressOf("owner-repo", started, null)

    let rows: FollowRecord[]
    let unverifiable = false
    try {
        const fetched = await deps.fetchRepo(did)
        if (fetched.signingKey === null) {
            unverifiable = true
            throw new Error("the DID document has no #atproto key")
        }
        const verified = await deps.verifyRepo(fetched.car, {
            did,
            signingKey: fetched.signingKey,
            collection: FOLLOW_COLLECTION_NSID,
            maxBytes: config.maxRepoBytes,
            maxNodes: config.maxMstNodes,
            maxRecords: config.maxFollows,
        })
        rows = followRecordsOf(verified)
    } catch (error) {
        if (isCapError(error)) return switchToPaged(deps, listing, gen)
        if (error instanceof FetchTimeoutError) {
            if (listing.timeouts + 1 >= config.timeoutsBeforePaged) {
                return switchToPaged(deps, listing, gen)
            }
            return deferStep(deps, config, listing, gen, { timedOut: true, permanent: false })
        }
        const permanent = unverifiable || isPermanent(error)
        const bad = unverifiable || error instanceof RepoCollectionError
        return deferStep(
            deps,
            config,
            listing,
            gen,
            { timedOut: false, permanent },
            bad ? "unverifiable" : "failed"
        )
    }

    try {
        if (!(await deps.listings.stageRows(did, gen, rows, null, true))) return "superseded"
    } catch {
        return deferStep(deps, config, listing, gen, { timedOut: false, permanent: false })
    }
    listing.attempts = 0
    listing.timeouts = 0
    listing.permanentFailures = 0
    listing.inProgress = { ...listing.inProgress, phase: "drain", cursor: null }
    return "in-progress"
}

/**
 * Read `listRecords` pages into staging, for a paged owner (every follow) or
 * a mutual listing (follows of registered DIDs only), up to the pages left
 * this alarm. The PDS is resolved once, at the first page. A raw empty page
 * ends the fetch; so does a page that does not advance the cursor, and the
 * mutual listing's `maxFollows / 100` pages. Resolving the PDS counts as a
 * page, and so does a failed one. A failed page leaves the cursor where it was and defers.
 */
export async function fetchListingPages(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing,
    kind: "owner-paged" | "mutual",
    pagesLeft: number
): Promise<{ outcome: ListingOutcome; pagesUsed: number }> {
    const did = listing.did
    if (pagesLeft <= 0) return { outcome: "over-budget", pagesUsed: 0 }

    let gen: number
    let pds: string
    let cursor: string | null
    let pages: number
    let pagesUsed = 0
    const held = listing.inProgress
    if (held !== null && held.kind === kind && held.phase === "fetch" && held.pds !== null) {
        const resumed = await deps.listings.resumeListing(
            did,
            held.gen,
            provisionalNotBefore(deps, config, listing)
        )
        if (!resumed) return { outcome: "superseded", pagesUsed: 0 }
        listing.attempts += 1
        gen = held.gen
        pds = held.pds
        cursor = held.cursor
        pages = held.pages
    } else {
        pagesUsed = 1
        listing.attempts += 1
        try {
            pds = (await deps.resolvePds(did)).pds
        } catch (error) {
            const outcome = await deferStep(deps, config, listing, held?.gen ?? null, {
                timedOut: false,
                permanent: isPermanent(error),
            })
            return { outcome, pagesUsed }
        }
        const started = await deps.listings.beginListing(
            did,
            kind,
            deps.nowMs(),
            pds,
            provisionalNotBefore(deps, config, listing)
        )
        gen = started.gen
        cursor = null
        pages = 0
        listing.inProgress = progressOf(kind, started, pds)
    }

    const maxPages = Math.ceil(config.maxFollows / PAGE_SIZE)
    while (pagesUsed < pagesLeft) {
        pagesUsed += 1
        let page: FollowPage
        const kept: FollowRecord[] = []
        try {
            page = await deps.listFollows(pds, did, cursor)
            if (kind === "owner-paged") {
                kept.push(...page.records)
            } else {
                for (const record of page.records) {
                    if (await deps.interest.isRegistered(record.subject)) kept.push(record)
                }
            }
        } catch (error) {
            const permanent = isPermanent(error)
            const outcome = await deferStep(deps, config, listing, gen, {
                timedOut: !permanent,
                permanent,
            })
            return { outcome, pagesUsed }
        }
        const stuck = cursor !== null && page.lastRkey !== null && page.lastRkey <= cursor
        pages += 1
        const done =
            page.lastRkey === null || stuck || (kind === "mutual" && pages >= maxPages)
        const next = stuck ? cursor : (page.lastRkey ?? cursor)
        try {
            if (!(await deps.listings.stageRows(did, gen, kept, next, done))) {
                return { outcome: "superseded", pagesUsed }
            }
        } catch {
            const outcome = await deferStep(deps, config, listing, gen, {
                timedOut: false,
                permanent: false,
            })
            return { outcome, pagesUsed }
        }
        cursor = next
        listing.attempts = 0
        listing.timeouts = 0
        listing.permanentFailures = 0
        listing.inProgress = done
            ? { ...listing.inProgress!, phase: "drain", cursor: null, pages }
            : { ...listing.inProgress!, cursor, pages }
        if (done) break
    }
    return { outcome: "in-progress", pagesUsed }
}

/**
 * Write staged rows to D1 at the listing's generation, a chunk at a time
 * while the chunk's worst case fits the reserve left, saving the cursor
 * after each. After the last chunk: sweep older generations, then
 * `completeListing`.
 */
export async function drainListing(
    deps: FollowBackfillDeps,
    config: FollowBackfillConfig,
    listing: QueuedListing,
    reserveLeft: () => number
): Promise<ListingOutcome> {
    const progress = listing.inProgress
    if (progress === null || progress.phase !== "drain") return "superseded"
    const did = listing.did
    const { gen } = progress
    let cursor = progress.cursor
    let committed = false
    try {
        for (;;) {
            const left = reserveLeft()
            const limit = chunkEdgesWithoutSweep(left)
            const rows = await deps.listings.stagedRows(did, cursor, Math.max(limit, 1))
            if (rows.length === 0) {
                if (left < SWEEP_STATEMENTS) {
                    return committed ? "in-progress" : "over-budget"
                }
                const swept = await deps.edges.sweep(did, gen)
                const done = await deps.listings.completeListing(did, gen, {
                    beganAtMs: progress.beganAtMs,
                    nowMs: deps.nowMs(),
                    subjects: swept.subjects,
                })
                if (!done) return "superseded"
                listing.inProgress = null
                listing.attempts = 0
                return "listed"
            }
            if (limit === 0) return committed ? "in-progress" : "over-budget"
            const chunk = rows.slice(0, limit)
            const written = await deps.edges.putEdges(
                chunk.map((r) => ({ follower: did, rkey: r.rkey, subject: r.subject })),
                gen
            )
            cursor = chunk[chunk.length - 1]!.rkey
            const saved = await deps.listings.saveDrainProgress(did, gen, cursor, written.subjects)
            if (!saved) return "superseded"
            committed = true
            listing.attempts = 0
            listing.inProgress = { ...progress, cursor }
        }
    } catch {
        return deferStep(deps, config, listing, gen, { timedOut: false, permanent: false })
    }
}

/** Follows from a verified collection's records; a record with no string `subject` is skipped. */
export function followRecordsOf(verified: VerifiedCollection): FollowRecord[] {
    const follows: FollowRecord[] = []
    for (const { rkey, record } of verified.records) {
        const subject = (record as { subject?: unknown } | null)?.subject
        if (typeof subject === "string") follows.push({ rkey, subject })
    }
    return follows
}

/**
 * Whether the follow stream was down longer than Jetstream replays, judged
 * from when the socket was last known open (not from event times, which a
 * quiet stream leaves old). Checked before a reconnect stamps a new time.
 */
export function followGapExceeded(
    lastConnectedAtMs: number | null,
    nowMs: number,
    lookbackMs: number
): boolean {
    return lastConnectedAtMs !== null && nowMs - lastConnectedAtMs > lookbackMs
}

/**
 * Top the due queue up with listings older than `relistAfterMs` (reason
 * `stale`, which leaves one in progress or unlistable alone): queue
 * `maxPerAlarm − dueQueuedCount`, at least 0, oldest listed first, so the
 * re-list fills what capacity the queue leaves and never piles up ahead of
 * new work. Returns how many.
 */
export async function relistStale(
    deps: { listings: ListingIndex; nowMs(): number },
    config: { relistAfterMs: number; maxPerAlarm: number }
): Promise<number> {
    const now = deps.nowMs()
    const room = config.maxPerAlarm - (await deps.listings.dueQueuedCount(now))
    if (room <= 0) return 0
    return deps.listings.queueStaleListings(now - config.relistAfterMs, room, now)
}
