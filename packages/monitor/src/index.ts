/**
 * `@germ-network/atproto-pmr-monitor` — key monitor logic, parameterized
 * over a storage seam.
 *
 * A **key monitor** is not part of a PMR (`spec/key-transparency.md`): it
 * observes the collection in which DIDs publish messaging keys, holds a
 * snapshot of what it saw, and serves that snapshot as a community view, so
 * that a publisher showing different keys to different audiences is
 * detectable. A relay operator is encouraged, not required, to run one.
 *
 * This package makes no platform assumptions: no `fetch` global, no Workers
 * bindings, no WebSocket. The stream client, the PDS fetch, and storage are
 * all injected — which is also what keeps a monitor cheap enough that
 * several independent parties can run one, the property the redundancy
 * model depends on.
 *
 * It can also keep a relay's cached did:plc signing keys, and a stored DID
 * document per watched DID, current from the PLC directory's export stream
 * (`decodePlcExportFrame`, `intakePlcEvent`, `drainKeyUpdates`;
 * `spec/key-transparency.md`, "The signing-key cache" and "The stored DID
 * document"). Documents reach the stream's intake through `DidDocumentSink`,
 * and the monitor's own fetches through `IngestDeps.didDocuments`.
 *
 * The specification is in `spec/key-transparency.md`. Where this code and
 * the specification disagree, the specification is right and this is a bug.
 */

// The wake signal.
export {
    decodeEvent,
    type CommitEvent,
    type CommitOperation,
    type EventKind,
    type IdentityEvent,
    type MonitorEvent,
} from "./jetstream"

// The storage seam.
export {
    compareObservations,
    compareRev,
    type BackfillProgress,
    type Cursor,
    FETCH_AS_OF_SKEW_MS,
    type DidDocumentSink,
    type DigestMarker,
    type IntakeOutcome,
    type KeyUpdateIndex,
    type MonitorIndex,
    type OwedKeyUpdate,
    type Observation,
    type ObservationComparison,
    type PendingFailure,
    type PendingFetch,
    type RevComparison,
    type SnapshotEntry,
    type HolderState,
    type GoneCause,
    type IndexedRecord,
    type VerifiedWrite,
    type SigningKeyCacheWriter,
    type SnapshotStore,
    type InterestIndex,
    type InterestTransition,
    type OwedRecord,
    type PendingRecordFetch,
    type RecordRef,
    type SecondaryIndex,
    type SecondaryIntakeIndex,
    type SecondaryIntakeOutcome,
    type SecondarySnapshotStore,
    type SecondaryWriteAnswer,
    D1_ROWS_PER_STATEMENT,
    type BlockEdgeWriter,
    type BlockRef,
    type EdgeRef,
    type EdgeWriteResult,
    type FollowEdgeWriter,
    type GraphMirrorRow,
    type GraphMirrorTransition,
    type StatementBudget,
} from "./storage"

// The operator's read of ingest progress.
export {
    PENDING_ATTEMPT_BUCKETS,
    type FollowFrameFailures,
    type MonitorIngestStatus,
    type MonitorIngestStatusRequest,
    type MonitorPendingDetail,
    type PendingRowDetail,
    type PendingSummary,
} from "./status"

// The allow list and the secondary records it keeps.
export { applyInterestTransitions, type InterestDeps } from "./interest"
export {
    intakeSecondary,
    settleSecondary,
    settleSecondaryDue,
    type SecondaryConfig,
    type SecondaryDeps,
    type SecondaryIntakeDecision,
    type SecondarySettleFailureEvent,
    type SecondarySettleOutcome,
} from "./secondary"

// The follow/profile stream.
export {
    BLOCK_COLLECTION_NSID,
    EDGE_OPS_TABLE,
    FOLLOW_COLLECTION_NSID,
    followEventListingDid,
    routeFollowEvent,
    type EdgeCollection,
    type EdgeOp,
    type FollowRoute,
    type FollowRouteDeps,
    type FollowStreamIndex,
    type NewEdgeOp,
} from "./follow-stream"

// The follow-edge index: listings, the live flush, and the mirrored standing.
export {
    drainChunkEdges,
    drainListing,
    fetchListingPages,
    followGapExceeded,
    followRecordsOf,
    listOwner,
    relistStale,
    runListings,
    worstCaseDrainStatements,
    type FetchedRepo,
    type ResolvedPds,
    type FollowBackfillConfig,
    type FollowBackfillDeps,
    type FollowPage,
    type FollowRecord,
    type StagedRow,
    type ListingIndex,
    type ListingKind,
    type ListingOutcome,
    type ListingProgress,
    type ListingQueueReason,
    type QueuedListing,
    type StartedListing,
} from "./follow-backfill"
export {
    coalesceEdgeOps,
    drainRecounts,
    flushEdgeOps,
    flushLimit,
    flushStatements,
    reconcileOwnerFollowers,
    recountOwnerFollowers,
    recountStatements,
    type CoalescedOps,
    type EdgeFlushDeps,
    type EdgeOpsIndex,
    type OwnerFollowedIndex,
    type OwnerFollowerDeps,
    type QueuedRecount,
    type RecountQueueIndex,
} from "./follow-flush"
export {
    mirrorGraph,
    reconcileGraphMirror,
    type GraphMirrorDeps,
    type GraphMirrorIndex,
    type MirrorReconcileCursor,
} from "./graph-mirror"
export {
    drainPlcLogs,
    PLC_LOG_RETRY_MS,
    type DrainPlcLogsDeps,
    type PlcLogIndex,
} from "./plc-log"
export { listEdgeRecords, type ListEdgeRecordsOptions } from "./list-records"

// The change digest.
export {
    decodeDigestPage,
    decodeDigestWindows,
    encodeDigestPage,
    encodeDigestWindows,
    mightHaveChanged,
    nextWindow,
    sealDueWindows,
    sealWindow,
    serveDigest,
    sizeFor,
    windowOf,
    type DigestPage,
    type DigestWindow,
    type SealDeps,
    type ServeDeps,
} from "./digest"

// The digest endpoint.
export { handleDigest, type DigestEndpointDeps } from "./digest-endpoint"

// The registration surface: own-DID push.
export type { MonitorRegistration, MonitorRegistrationStore } from "./registration"
export {
    handleMonitorRegistrationCreate,
    handleMonitorRegistrationDelete,
    type MonitorRegistrationDeps,
} from "./registration-endpoint"

// The deliverer: sends the own-DID push.
export {
    pushDeclarationChange,
    type DeclarationPushSender,
    type NotifyDeps,
} from "./notify"

// The authoritative read.
export {
    fetchRecordCar,
    fetchHeadRev,
    fetchRepoCar,
    type FetchRepoOptions,
    type FetchHeadRevOptions,
    type HeadRev,
    type FetchRecordOptions,
} from "./fetch-record"

// Ingest orchestration.
export {
    intake,
    recordWatchedDocument,
    settle,
    settleDeletion,
    settleDue,
    settleRetryBackoffMs,
    SETTLE_RETRY_CAP_MS,
    PENDING_FAILURE_MESSAGE_MAX,
    type SettleFailureEvent,
    type FetchedDidDocument,
    type FetchedRecord,
    type IngestConfig,
    type IngestDeps,
    type IntakeDecision,
    type SettleOptions,
    type SettleOutcome,
    type SettledDeclaration,
    type VerifyOutcome,
} from "./ingest"

// The PLC directory's export stream: keeps the relay's signing-key cache and
// the stored did:plc documents current.
export {
    decodePlcExportFrame,
    drainKeyUpdates,
    intakePlcEvent,
    plcCursorAfterClose,
    type DrainKeyUpdatesDeps,
    type PlcCursorAction,
    type PlcDocumentChange,
    type PlcExportEvent,
    type PlcIntakeDecision,
    type SigningKeyUpdate,
} from "./plc-export"

// Tier 3: baseline build.
export { listReposByCollection, type ListReposOptions, type ListReposPage } from "./list-repos"
export { sweepBackfill, type BackfillDeps, type SweepBackfillResult } from "./backfill"
export {
    refreshDue,
    type RefreshDeps,
    type RefreshIndex,
    type RefreshSnapshots,
    type RefreshOutcome,
    type RefreshResult,
    type SnapshotCheck,
} from "./refresh"


export {
    computeFirehoseCoverage,
    isResumeJump,
    isStaleCursor,
    streamTimeUs,
    type FirehoseCoverageInput,
    type OwedStreamEvent,
} from "./firehose-coverage"
