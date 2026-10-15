# @germ-network/atproto-pmr-core

## 0.1.5

### Patch Changes

- [#44](https://github.com/germ-network/atproto-pmr/pull/44) [`141af0d`](https://github.com/germ-network/atproto-pmr/commit/141af0d9f32ffbce2736eec9d62eb4bd16205dee) Thanks [@germ-mark](https://github.com/germ-mark)! - Add `verifyRecordProofOutcome`, which returns a valid absence proof's signed rev instead of throwing. A patch bump because the packages are pre-1.0 and a minor would cascade to 1.0.0.

- [#54](https://github.com/germ-network/atproto-pmr/pull/54) [`43de8ae`](https://github.com/germ-network/atproto-pmr/commit/43de8aecece665eb7b88494d8c590a44ab49a726) Thanks [@germ-mark](https://github.com/germ-mark)! - Devices can read a DID's signed `did:plc` operation log, or a `did:web` document as a hint.

  New in core: `handleDidDocRead` (`GET /pmr/v1/did/{did}`) with its codec (`DID_DOC_READ_KEYS`, `PLC_LOG_ENTRY_KEYS`, `PLC_COVERAGE_KEYS`) and `PlcLogStore`; `parsePlcAuditLog`, `verifyPlcLog`, `appendPlcLogEntry` and `PlcLogError`, which verify a log the way a device does (including a legacy `create` genesis and nullified operations); `fetchPlcAuditLog`. `verifyMultikeySignature`, `encodeDagCbor` and `base32Lower` are now exported from repo-proof internals for them.

  The monitor keeps a log for each watched `did:plc` DID: the export stream extends it (an appended operation's signature is checked) or owes a fetch of the directory's audit log, which `drainPlcLogs` fetches and verifies at a bounded rate (`PLC_LOG_DRAIN_BATCH`, default 20 per alarm) before it is stored and published as `plclog:<did>` (`kvPlcLogs`). A stored log confirms the document it renders. `intakePlcEvent` takes an optional `PlcLogIndex`, and `PlcExportEvent` gains `entry`. After a restart of the stream's unbroken run every held log is fetched again, so a large `everyone` deployment spends many alarms re-fetching.

- [#53](https://github.com/germ-network/atproto-pmr/pull/53) [`e51f69c`](https://github.com/germ-network/atproto-pmr/commit/e51f69c92c23fe5ef4d8b511e1f8dc6756fb9fbf) Thanks [@germ-mark](https://github.com/germ-mark)! - Device reads serve the rev and CID ingest verified and fail closed on a rotated signing key, and the owner's summary is paged.

  `handleRecordRead` takes `rev` and `cid` from the stored snapshot's verified metadata, and requires `RecordReadDeps.signingKeys`: a snapshot verified under a key other than the DID's trusted current key, or for a `did:plc` DID with no trusted key, reads `unverifiable`; `did:web` is served on its ingest verdict. `readSigningKeyFrom`, `servableUnderRotation` and `kvReadSigningKeys` (monitor-cloudflare) implement the trust rule: a cached document is trusted while the PLC stream has covered it continuously since its fetch, otherwise for ten minutes.

  Wire change: the summary response gains `more` (`m`) and `truncated` (`n`); a decoder that ignores unknown keys is unaffected. A response carries at most `SUMMARY_PAGE_RECORDS` changed records; `handleSummaryRead` now takes `SummaryPageDeps` (`buildSummary` and `SummaryDeps` are removed) and `kvSummaryIndexReader` (monitor-cloudflare) builds the index from bulk metadata reads without reading any CAR. An owner's contacts are capped at `SUMMARY_MAX_RECORDS` over the watched count.

  Breaking for custom stores: `PMRStore.putSummaryIndex` takes an optional `replaces` token. `PMRObject` stores each index in size-bounded parts.

- [#39](https://github.com/germ-network/atproto-pmr/pull/39) [`35c650e`](https://github.com/germ-network/atproto-pmr/commit/35c650e75818ced2812e3797f5adc4057083fb70) Thanks [@germ-mark](https://github.com/germ-mark)! - Device-facing read API handlers: public record and graph reads, and the owner's summary with `?since=` token deltas. Routes are wired by the deployment.

  New in core: `handleRecordRead` (`GET /pmr/v1/records/{did}/{collection}/{rkey}`, with `RecordReadDeps.serves` gating which DIDs are served), `dedupedRecheck`, `projectGraph`, `handleGraphRead` (`GET /pmr/v1/graph/{did}`), `GraphProjectionStore`, `GraphProjectionWriter`, the record and graph response codecs, `handleSummaryRead` (`GET /pmr/v1/summary`), `buildSummary`, `diffSummaryIndex`, the summary codec with `SUMMARY_DELTA_KEYS` / `SUMMARY_RECORD_KEYS`, and `SUMMARY_TOKENS_KEPT`. Public reads are unauthenticated and `no-store`; a lapsed declaration is served as held and its re-check goes to `waitUntil`.

  Breaking for custom stores: `PMRStore` gains `putSummaryIndex` / `getSummaryIndex`; `PMRObject` implements them.

  New in monitor-cloudflare: `kvGraphProjections`, the KV store for graph projections under `graph:<did>`.

- [#43](https://github.com/germ-network/atproto-pmr/pull/43) [`8c90282`](https://github.com/germ-network/atproto-pmr/commit/8c90282588d42add175511763b32124a9916295f) Thanks [@germ-mark](https://github.com/germ-mark)! - Keep a DID document for each watched DID, and let a relay trust it for 24 hours under published export-stream coverage, ten minutes otherwise.

  A monitor stores the document its fetches resolve (the record fetch and the refresh's head read) and, for `did:plc` with `PLC_EXPORT_STREAM_URL` set, renders each operation on the export stream into the document the directory serves. Writes are ordered by when the directory held the state they describe. `MonitorIngest` publishes `doc:<did>` to the records store, and `plc:coverage` once the stream's unbroken run is stored with the cursor. The export consumer is the one that already keeps the signing-key cache current: still one socket, one cursor and one decode.

  New in core: `renderPlcDocument`, `storedSigningKeyResolver`, `pdsResolutionFromDocument`, `STORED_DID_DOCUMENT_MAX_AGE_MS`, `PLC_COVERAGE_MAX_LAG_MS`, `PlcCoverage`, `StoredSigningKeyResolverDeps`; `fetchDidDocument` and `extractSigningKey` are now exported from the package index.

  New in monitor: `DidDocumentSink`, `FETCH_AS_OF_SKEW_MS`, `PlcDocumentChange`, `IngestDeps.didDocuments`, `FetchedRecord.didDocument`, `FetchedDidDocument`, `FetchHeadRevOptions` (`onDidDocument`, `nowMs`), `FetchRecordOptions.nowMs`. `PlcExportEvent` gains `createdAtMs` and `change`; `intakePlcEvent` takes an optional document sink; `KeyUpdateIndex.advancePlcCursor` and `oweKeyUpdate` take an optional `createdAtMs`.

  New in monitor-cloudflare: `kvDidDocuments`, `kvPlcCoverage`. `MonitorIngest` implements `DidDocumentSink`, adds `publishDidDocuments` and `publishPlcCoverage`, and its PLC cursor row also carries the coverage run's start. A subclass that overrides `fetchHeadRev` must pass its document to `recordDidDocument`.

- [#50](https://github.com/germ-network/atproto-pmr/pull/50) [`45971f2`](https://github.com/germ-network/atproto-pmr/commit/45971f28cedea6ce4cab9b72c2330716e47588a6) Thanks [@germ-mark](https://github.com/germ-mark)! - Follow listings for the follow-edge index: a graph owner's repo is read once with `getRepo`, verified, staged in the monitor's own storage and written to D1 across alarms; an owner past the walk's caps, and a non-owner's mutual hints, are listed by unverified `listRecords` pages.

  New in core: `guardedFetchStream` (a streamed, guarded fetch raising `FetchTimeoutError` or `BodyTooLargeError`), and on `verifyRepoCollection` the `maxRecords` cap (`record-cap-exceeded`) and the `onRetained` report of what the read kept (`RetainedBlocks`).

  Patch, not minor: the packages are pre-1.0 and a minor bump would cascade to 1.0.0. The monitor object's own SQLite gains tables and columns on first start; no D1 migration and no new binding.

- [#52](https://github.com/germ-network/atproto-pmr/pull/52) [`d6b4fda`](https://github.com/germ-network/atproto-pmr/commit/d6b4fdac6cac4bf1105279c3f91e4ce61cc97a50) Thanks [@germ-mark](https://github.com/germ-mark)! - The monitor keeps the public graph projections in step with the edge index, and a lapsed-declaration read can ask for an earlier refresh.

  `runGraphProjector` (monitor) tails the edge index's change log from the alarm, re-projecting each served graph a row names, deleting the projection of one no longer served, and rebuilding when its cursor falls behind retention. `GRAPH_PROJECTOR_BATCH` (default 200) bounds the DIDs written per alarm. `GraphProjectionWriter` gains `listDids`, implemented by `kvGraphProjections`.

  `MonitorRecheckRequest` (core) and `MonitorIngest.requestRefresh` queue a DID for refresh ahead of the usual order without making it due, at most a quarter of a batch; `monitorRecheck(env)` (cloudflare) is the relay's `requestRecheck` for a bound monitor.

  Also exported, not yet implemented and not used by any route: the read signing-key reader, the paged summary (`more`, `truncated`), the PLC operation-log verifier and the DID-document read. They arrive in follow-up releases.

- [#37](https://github.com/germ-network/atproto-pmr/pull/37) [`ebb0fa0`](https://github.com/germ-network/atproto-pmr/commit/ebb0fa0f3b4412154874e4972047325952a57b5b) Thanks [@germ-mark](https://github.com/germ-mark)! - Interest-policy and consumer types for the proxy cache's allow list.

  New: `InterestPolicy`, `parseInterestPolicy`, `GraphChangeReason`, `GraphChangeRow`, `GraphChangeLog`, `InterestReader`. `StoredRecordSnapshot` gains nullable `rev` and `cid`. `WatchedDidSet` is now `"interest"` (was `"declarations"`).

- [#42](https://github.com/germ-network/atproto-pmr/pull/42) [`325717c`](https://github.com/germ-network/atproto-pmr/commit/325717cf40735670572bed212758d731b7d5e808) Thanks [@germ-mark](https://github.com/germ-mark)! - Keep a relay's cached did:plc signing keys current from the PLC directory's export stream.

  New optional env var on the monitor: `PLC_EXPORT_STREAM_URL`. Unset, nothing changes except that identity events now owe a cache delete for every watched DID; set, `MonitorIngest` holds a second outbound socket, resumes from a stored `seq` (or the tip), and applies each op for a watched DID to the `sk:` cache. For `did:plc` the stream replaces the Jetstream identity hint, which then covers other DIDs only.

  New in monitor: `decodePlcExportFrame`, `intakePlcEvent`, `drainKeyUpdates`, `plcCursorAfterClose`, the `KeyUpdateIndex` and `SigningKeyCacheWriter` interfaces, their `OwedKeyUpdate`, `PlcExportEvent`, `SigningKeyUpdate`, `PlcCursorAction`, `PlcIntakeDecision` and `DrainKeyUpdatesDeps` types, `IngestDeps.keyUpdates`. `MonitorIngest` gains the `KeyUpdateIndex` methods.

  New in monitor-cloudflare: `kvSigningKeyCache`, the `sk:<did>` adapter for the relay's cache and the consumer.

- [#35](https://github.com/germ-network/atproto-pmr/pull/35) [`93f5727`](https://github.com/germ-network/atproto-pmr/commit/93f57278ba7f41fcf5bf535a91b969784f7bcc62) Thanks [@germ-mark](https://github.com/germ-mark)! - Interfaces for the PMR proxy-cache model: per-collection record snapshots, the follow-edge and DID-document stores, the watched-set configuration, and the device read response bodies.

  New: `RecordSnapshotStore`, `StoredRecordSnapshot`, `FollowEdge`, `FollowEdgeStore`, `DidDocument`, `DidVerificationMethod`, `DidService`, `DidDocumentSource`, `CachedDidDocument`, `DidDocumentCache`, `WatchedRecord`, `WatchedDidSet`, `WatchedCollection`, `parseMonitorCollections`, `RecordReadMiss`, `RecordReadResponse`, `GraphEdge`, `GraphReadResponse` with their `*_KEYS` constants, `DECLARATION_COLLECTION_NSID` (core); `snapshotKeys` (monitor-cloudflare).

- [#46](https://github.com/germ-network/atproto-pmr/pull/46) [`559f60f`](https://github.com/germ-network/atproto-pmr/commit/559f60fdac31cdf1b93a4be122e1ba951483384d) Thanks [@germ-mark](https://github.com/germ-mark)! - `RecordNotFoundError` carries `reason`, the XRPC error name that confirmed the state (`RecordNotFound`, `RepoNotFound`, `RepoTakendown`, …), or null when it was confirmed by message prefix (a did:plc tombstone). Only `RecordNotFound` is record-level; callers treat anything else, null included, as the repo or DID being gone. The constructor takes it as an optional third argument.

- [#40](https://github.com/germ-network/atproto-pmr/pull/40) [`010eb81`](https://github.com/germ-network/atproto-pmr/commit/010eb81ac3137817ff592ea5e3ca77da1ba9e91a) Thanks [@germ-mark](https://github.com/germ-mark)! - The relay's `KVDirectory` tells an optional monitor about registrations: `create` calls `register(did)` (also for an already-present DID), `delete` calls `unregister(did)`. Reached through the optional `MONITOR_INGEST` Durable Object namespace and `MONITOR_INGEST_NAME`; best-effort, logged and never failing the write, and a no-op when unbound. New in core: the structural `MonitorRegistrationNotify` interface.

- [#38](https://github.com/germ-network/atproto-pmr/pull/38) [`2721824`](https://github.com/germ-network/atproto-pmr/commit/2721824adb9222fafe0c81d81d8d0a4afef852a5) Thanks [@germ-mark](https://github.com/germ-mark)! - `verifyRepoCollection` streams a `com.atproto.sync.getRepo` CAR and returns every record of one collection (for example `app.bsky.graph.follow`) with its rkey and CID and the signed rev. It verifies the commit signature against the DID document's signing key, hash-checks every block it keeps, and walks the collection's whole key range in the signed tree. Only the commit, MST nodes and candidate record blocks are retained, in any block order, under byte and node caps.

  New: `verifyRepoCollection`, `RepoCollectionError`, `DEFAULT_MAX_REPO_BYTES`, `DEFAULT_MAX_MST_NODES`, `CollectionRecord`, `RepoCollectionErrorCode`, `RepoCollectionExpectation`, `VerifiedCollection` (core).

## 0.1.4

### Patch Changes

- [#32](https://github.com/germ-network/atproto-pmr/pull/32) [`450cf43`](https://github.com/germ-network/atproto-pmr/commit/450cf43977fa8884848a4eb098711d9cb5ddbb69) Thanks [@germ-mark](https://github.com/germ-mark)! - The relay pins the sender's declaration CID, and verifies it from the monitor instead of the sender's PDS.

  Fix: the anchor key algorithm byte for Ed25519 signing is `3`, not `2` (the identifier table omitted AES-GCM-256 at index 0). This is a pre-existing bug: the relay rejected every real declaration.

  Breaking:

  - The delivery hint is `sd` + `dc` and no longer carries `kt`. `dc` is the declaration record's CID (CIDv1, dag-cbor, sha2-256, base32 lower, `bafyrei…`) and is a freshness cue, not a trust signal. `VerificationHint.anchorKeyThumbprint` is replaced by `declarationCID`; a stored hint without one emits no hint. This applies to `#delivery`, `GET /pmr/v1/messages` and full-form push.
  - `PairPutDeps.resolveDeclaration` returns `SenderDeclarationResolution` (anchor key plus `declarationCID`). Wire `snapshotDeclarationResolver` (with `kvDeclarationSnapshots` and `cachedSigningKeyResolver`) for senders; the PDS resolver is now for owner-DID reads only.
  - A pair put whose sender declaration is unknown, stale or unverifiable, or whose signature fails under the resolved key, answers `409` with `Retry-After` and stores nothing. A validly signed put to an unknown or different recipient still answers `202`.
  - `VerifyOutcome`'s failure arm gains `code: "signature" | "recipient"`.
  - `fetchLatestRev` takes optional terminal-error names.

  New:

  - `verifyRecordProof` / `readRecordFromCar`: single-record repo proofs (CAR, commit signature, MST path).
  - The monitor re-confirms every held snapshot on its alarm, storing advances with an unchanged declaration quietly, so a quiet sender's snapshot stays current. A snapshot unconfirmed for `SNAPSHOT_MAX_AGE_MS` (24 h) is checked against the sender's PDS for change only (required `SnapshotDeclarationDeps.fetchDirect(did, collection, rkey)`; core exports `fetchRecordProofCar` for it; the answer is remembered for 10 min): unchanged stands, changed or gone is not found, an unreadable PDS falls back to the snapshot. `MonitorIngest` gains a `checks` table and `fetchHeadRev`; `kvDeclarationSnapshots` serves `{car, freshAtMs}`.
  - New monitor env vars `REFRESH_BATCH` and `REFRESH_STALE_AFTER_MS` (defaults 64 and 3600000, set in `wrangler.example.toml`; declare them in the env type).
  - Generic snapshot record reader: `snapshotRecordReader` verifies and reads any record from a snapshot (with the 24 h rule); `snapshotDeclarationResolver` is a thin wrapper over it, and `fetchDirect` takes `(did, collection, rkey)`.

## 0.1.3

### Patch Changes

- [#30](https://github.com/germ-network/atproto-pmr/pull/30) [`f47481b`](https://github.com/germ-network/atproto-pmr/commit/f47481b01861138be218e5ac3025ea35be10f5e1) Thanks [@germ-mark](https://github.com/germ-mark)! - Re-registration with a different anchor key now deactivates and replaces the prior registration instead of refreshing the stored key in place. Same-key re-registration is unchanged (idempotent in-place refresh).

## 0.1.2

### Patch Changes

- [#28](https://github.com/germ-network/atproto-pmr/pull/28) [`bbaccf8`](https://github.com/germ-network/atproto-pmr/commit/bbaccf810ca951b18eaab9cd53320eb09b0bb324) Thanks [@germ-mark](https://github.com/germ-mark)! - Declaration watch: add the monotonic-rev watermark.

  `WatchState` gains the spec's "last observed declaration revision"
  (`lastObservedRev`, optional), and `applyDeclarationOutcome` refuses a
  `present`/`absent` whose observed repo rev is not strictly newer than the stored
  one — so a reordered or replayed recheck (Cloudflare Queues are unordered +
  at-least-once), or a PDS rev that moved backwards, cannot clobber a fresher
  pause decision. The decision is still made on the `currentKey` value; the rev is
  only an ordering token. `resolveDeclarationWithRev` reads that rev
  (`getLatestCommit`) on the recheck path only, never the hot pair-put path.
  `compareRev`/`RevComparison` and `fetchLatestRev` move to core as the single
  definition the monitor and the watch share.

## 0.1.1

### Patch Changes

- [#23](https://github.com/germ-network/atproto-pmr/pull/23) [`ade4873`](https://github.com/germ-network/atproto-pmr/commit/ade4873f39246c0dd9d5ac10435d0bd3880b292a) Thanks [@germ-mark](https://github.com/germ-mark)! - Add the own-DID declaration watch (pause-not-teardown).

  When the registration owner's own Germ declaration is **confirmed** to no longer
  carry its trusted anchor key — gone, or a different key — the registration
  **pauses** rather than tears down: DID-addressed (pair, and recovery-pool) mail
  is absorbed with the same uniform response a real append gives, grant-addressed
  mail keeps flowing, and it unpauses when the key returns. Absence is acted on
  only when confirmed, never inferred from a transient/unreachable PDS.

  - **core**: a `WatchState` and a `WatchOutcome` on `PMRStore`, with
    `readWatchState`/`writeWatchState` and `applyDeclarationOutcome` (the atomic
    read-modify-write of the paused flag); the pure decision logic in `watch.ts`
    (`classifyDeclaration`/`reconcileWatchState`); and a `confirmed` discriminator
    on `DeclarationResolution` (backed by a new optional `terminalErrorNames` on
    `guardedFetchJSON`) so a confirmed disappearance is distinguishable from a
    transient one. Pause enforcement is specified on `append`/`appendToPool`; the
    pair-put admission path is unchanged (it reads only `.found`).
  - **cloudflare**: `PMRObject` enforces the pause inside `append`/`appendToPool`
    (pair keys only — grant mail passes through) and implements
    `applyDeclarationOutcome`. It takes **no network dependency and schedules no
    work of its own**: the re-check is driven externally. A deployment re-fetches
    the declaration authoritatively (e.g. from a firehose-fed queue consumer) and
    calls `applyDeclarationOutcome`; a `MonitorIngest` subclass can drive it by
    overriding the existing `onChange`/`onRegression`/`onDelete` hooks. Mail
    already queued when a pause begins is left in place — pause is not teardown.
