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
 * It can also keep a relay's cached did:plc signing keys current from the
 * PLC directory's export stream (`decodePlcExportFrame`, `intakePlcEvent`,
 * `drainKeyUpdates`; `spec/key-transparency.md`, "The signing-key cache").
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
    type DigestMarker,
    type IntakeOutcome,
    type KeyUpdateIndex,
    type MonitorIndex,
    type OwedKeyUpdate,
    type Observation,
    type ObservationComparison,
    type PendingFetch,
    type RevComparison,
    type SnapshotEntry,
    type SigningKeyCacheWriter,
    type SnapshotStore,
} from "./storage"

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
export { fetchRecordCar, fetchHeadRev, type FetchRecordOptions } from "./fetch-record"

// Ingest orchestration.
export {
    intake,
    settle,
    settleDue,
    type FetchedRecord,
    type IngestConfig,
    type IngestDeps,
    type IntakeDecision,
    type SettleOutcome,
} from "./ingest"

// Signing-key cache invalidation from the PLC export stream.
export {
    decodePlcExportFrame,
    drainKeyUpdates,
    intakePlcEvent,
    plcCursorAfterClose,
    type DrainKeyUpdatesDeps,
    type PlcCursorAction,
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
