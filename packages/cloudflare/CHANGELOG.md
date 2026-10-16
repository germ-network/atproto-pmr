# @germ-network/atproto-pmr-cloudflare

## 0.1.8

### Patch Changes

- Updated dependencies []:
  - @germ-network/atproto-pmr-core@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies []:
  - @germ-network/atproto-pmr-core@0.1.7

## 0.1.6

### Patch Changes

- [#55](https://github.com/germ-network/atproto-pmr/pull/55) [`848de1e`](https://github.com/germ-network/atproto-pmr/commit/848de1e573f0237f8498cf8a9f2f41250e7e642d) Thanks [@germ-mark](https://github.com/germ-mark)! - The monitor ingests `app.bsky.graph.block` records and serves an owner their own block list through the authenticated summary.

  Blocks of a served graph's owner, and a non-owner in interest's blocks of registered DIDs, are kept in a new D1 `blocks` table (migration `0002_blocks.sql`; apply it before deploying) beside the follows. They arrive on the follow socket, which now subscribes to the block collection (a one-time change of its URL), and listings read them with the follows: owner repos verify both collections in one `getRepo` pass (`verifyRepoCollections`, each under its own cap, with the new optional `MAX_BLOCKS`), paged and mutual listings page follows then blocks. A DID's blocks are pruned with its follows. Blocks are not projected or served publicly, since no device reads other DIDs' block lists and serving them would cost; they have no projection or route.

  The owner's summary carries their own blocks under `b` (`SummaryDelta.ownBlocks`, null when unchanged). The ingest object answers `ownBlocks(did)` over RPC (`MonitorOwnBlocksRequest`), and a relay passes `blocks: monitorOwnBlocks(env)` in its summary deps; a failed read answers `503`, an unserved graph `409`. `BlockEdgeStore.isBlocked` answers whether one DID's kept block names another. `MONITOR_COLLECTIONS` now refuses the follow and block collections.

- [#58](https://github.com/germ-network/atproto-pmr/pull/58) [`8f8356c`](https://github.com/germ-network/atproto-pmr/commit/8f8356cdc14c06595e32ecbca1357ec80d5c05b5) Thanks [@germ-mark](https://github.com/germ-mark)! - No route, store or job publishes a follow graph, and the summary carries none.

  Removed: `GET /pmr/v1/graph/{did}` (`handleGraphRead`), the `graph:<did>` KV projection (`kvGraphProjections`), the graph projector (`runGraphProjector`, `GRAPH_PROJECTOR_BATCH` and its types), the projection store types (`GraphProjectionStore`, `GraphProjectionWriter`, `GraphReadDeps`), `projectGraph`, and the graph wire types and codecs (`GraphReadResponse`, `GraphEdge`, `GRAPH_READ_KEYS`, `GRAPH_EDGE_KEYS`, `encodeGraphReadResponse`, `decodeGraphReadResponse`). The summary no longer has `g` (`SummaryDelta.graph`; the key is retired), and the stored baseline holds the owner's DID instead of a graph. Devices read the record and DID-document routes and the owner's summary only.

  The summary chooses its contacts privately: the ingest object answers `ownGraph(did)` over RPC (`MonitorOwnGraphRequest`, one D1 batch via `FollowEdgeStore.ownEdges`), and a relay passes `graph: monitorOwnGraph(env)` in its summary deps instead of `projections`. A summary poll now makes two ingest RPCs (`ownGraph` and `ownBlocks`) where it made one KV read. `409` now means the owner's graph is not served yet; a failed graph or blocks read answers `503`. `SummaryOwnBlocksError` is now `SummaryOwnerReadError`, and `FollowEdgeStore.following`/`followers` are replaced by `ownEdges`; core exports `ownerGraph`, `OwnerGraph` and `OwnerGraphEdge`. When deploying, unmount the graph route, remove `GRAPH_PROJECTOR_BATCH` from the Worker config, and delete any `graph:<did>` keys left in the records KV.

- [#61](https://github.com/germ-network/atproto-pmr/pull/61) [`79a62ba`](https://github.com/germ-network/atproto-pmr/commit/79a62ba915a06ff7ffc087fe43c51310ea461607) Thanks [@germ-mark](https://github.com/germ-mark)! - A pair put is judged when it arrives: does the hosted recipient accept this sender? The relay routes it in one `PMRStore.receive` call: delivered to an admitted mailbox, pooled with the verdict's reasons, or handled as from a blocked sender. The recipient's Bsky blocks are mirrored into the relay block at accept and at each catch-up. Every outcome stays a `202` or `429`.

  Added: `PairPutDeps.admission` (`AdmissionSource`, `admissionOrUnavailable`, `admissionOf`), `PMRStore.receive`, `syncBskyBlocks` and `listBskyBlocked`, `block(key, now, source)`, `syncOwnerBlocks`, `EventsDeps.blocks` and `OwnerDeps.blocks`, and `d1AdmissionSource` in monitor-cloudflare. `d1SenderGraphReader` and `d1BlockEdgeStore` now take `Pick<D1Database, "prepare" | "batch">`. `GET /pmr/v1/pool` entries gain `v` and `r` for a sender the relay judged, and `GET /pmr/v1/blocks` gains `bs`. A yes admitted only by `open` is held back and pools as unknown until a relay bounds admitted senders.

  When deploying, pass `admission: d1AdmissionSource({ db, snapshots })` in the pair-put deps and `blocks: monitorOwnBlocks(env)` in the owner deps. The relay Worker then needs bindings to the monitor's D1 database and records KV; it only reads them (graph reads go through a D1 session that may be served by a replica), but D1 has no read-only binding. Without `admission`, puts behave as before.

- [#62](https://github.com/germ-network/atproto-pmr/pull/62) [`8381ebe`](https://github.com/germ-network/atproto-pmr/commit/8381ebe100e1ad751abf84d598abb4f11e36230a) Thanks [@germ-mark](https://github.com/germ-mark)! - The owner's summary carries the owner's can-message verdict for each covered contact: changed verdicts under `c` (`SummaryDelta.verdicts`) and the contacts that lost one under `y` (`droppedVerdicts`). A contact with no servable declaration has no verdict, which is not a `no`.

  Deployers must pass the new required `senderGraph` in the summary deps, `d1SenderGraphReader(<graph D1>.withSession())`, so the relay binds the monitor's D1; `d1SenderGraphReader` and `d1BlockEdgeStore` now accept a D1 session. A can-message verdict that only `open` admits is now `unknown [policy-not-enabled]` on the public route and in the summary, as receive-time admission already treated it (the rule now lives in `evaluateCanMessage`; `POLICY_NOT_ENABLED` is still exported). A failed read of the contacts' graph facts answers `503` with `Retry-After`. A custom `SummaryIndexReader` must return a declaration entry's stored `policies` (`SummaryHeldEntry.policies`), or every contact reads `unknown [declaration-unavailable]`; `kvSummaryIndexReader` does. New exports: `indexPolicySource`, `SummaryVerdict`, `SUMMARY_VERDICT_KEYS`, and `D1Reader` in monitor-cloudflare. A summary poll makes one more set of D1 reads, through a replica session and not through the ingest object. Summary baselines stored before this change resend every verdict once, and a declaration stored before policies were kept reads `unknown [declaration-unavailable]` in the summary until the account's next repo commit rewrites it.

- Updated dependencies [[`848de1e`](https://github.com/germ-network/atproto-pmr/commit/848de1e573f0237f8498cf8a9f2f41250e7e642d), [`fb8969d`](https://github.com/germ-network/atproto-pmr/commit/fb8969d03d33aea86d9bbc44a34f349b3fdf01d2), [`2d32f67`](https://github.com/germ-network/atproto-pmr/commit/2d32f67dac1182b3effddec2aa77301252ced37e), [`8f8356c`](https://github.com/germ-network/atproto-pmr/commit/8f8356cdc14c06595e32ecbca1357ec80d5c05b5), [`79a62ba`](https://github.com/germ-network/atproto-pmr/commit/79a62ba915a06ff7ffc087fe43c51310ea461607), [`8381ebe`](https://github.com/germ-network/atproto-pmr/commit/8381ebe100e1ad751abf84d598abb4f11e36230a)]:
  - @germ-network/atproto-pmr-core@0.1.6

## 0.1.5

### Patch Changes

- [#53](https://github.com/germ-network/atproto-pmr/pull/53) [`e51f69c`](https://github.com/germ-network/atproto-pmr/commit/e51f69c92c23fe5ef4d8b511e1f8dc6756fb9fbf) Thanks [@germ-mark](https://github.com/germ-mark)! - Device reads serve the rev and CID ingest verified and fail closed on a rotated signing key, and the owner's summary is paged.

  `handleRecordRead` takes `rev` and `cid` from the stored snapshot's verified metadata, and requires `RecordReadDeps.signingKeys`: a snapshot verified under a key other than the DID's trusted current key, or for a `did:plc` DID with no trusted key, reads `unverifiable`; `did:web` is served on its ingest verdict. `readSigningKeyFrom`, `servableUnderRotation` and `kvReadSigningKeys` (monitor-cloudflare) implement the trust rule: a cached document is trusted while the PLC stream has covered it continuously since its fetch, otherwise for ten minutes.

  Wire change: the summary response gains `more` (`m`) and `truncated` (`n`); a decoder that ignores unknown keys is unaffected. A response carries at most `SUMMARY_PAGE_RECORDS` changed records; `handleSummaryRead` now takes `SummaryPageDeps` (`buildSummary` and `SummaryDeps` are removed) and `kvSummaryIndexReader` (monitor-cloudflare) builds the index from bulk metadata reads without reading any CAR. An owner's contacts are capped at `SUMMARY_MAX_RECORDS` over the watched count.

  Breaking for custom stores: `PMRStore.putSummaryIndex` takes an optional `replaces` token. `PMRObject` stores each index in size-bounded parts.

- [#39](https://github.com/germ-network/atproto-pmr/pull/39) [`35c650e`](https://github.com/germ-network/atproto-pmr/commit/35c650e75818ced2812e3797f5adc4057083fb70) Thanks [@germ-mark](https://github.com/germ-mark)! - Device-facing read API handlers: public record and graph reads, and the owner's summary with `?since=` token deltas. Routes are wired by the deployment.

  New in core: `handleRecordRead` (`GET /pmr/v1/records/{did}/{collection}/{rkey}`, with `RecordReadDeps.serves` gating which DIDs are served), `dedupedRecheck`, `projectGraph`, `handleGraphRead` (`GET /pmr/v1/graph/{did}`), `GraphProjectionStore`, `GraphProjectionWriter`, the record and graph response codecs, `handleSummaryRead` (`GET /pmr/v1/summary`), `buildSummary`, `diffSummaryIndex`, the summary codec with `SUMMARY_DELTA_KEYS` / `SUMMARY_RECORD_KEYS`, and `SUMMARY_TOKENS_KEPT`. Public reads are unauthenticated and `no-store`; a lapsed declaration is served as held and its re-check goes to `waitUntil`.

  Breaking for custom stores: `PMRStore` gains `putSummaryIndex` / `getSummaryIndex`; `PMRObject` implements them.

  New in monitor-cloudflare: `kvGraphProjections`, the KV store for graph projections under `graph:<did>`.

- [#52](https://github.com/germ-network/atproto-pmr/pull/52) [`d6b4fda`](https://github.com/germ-network/atproto-pmr/commit/d6b4fdac6cac4bf1105279c3f91e4ce61cc97a50) Thanks [@germ-mark](https://github.com/germ-mark)! - The monitor keeps the public graph projections in step with the edge index, and a lapsed-declaration read can ask for an earlier refresh.

  `runGraphProjector` (monitor) tails the edge index's change log from the alarm, re-projecting each served graph a row names, deleting the projection of one no longer served, and rebuilding when its cursor falls behind retention. `GRAPH_PROJECTOR_BATCH` (default 200) bounds the DIDs written per alarm. `GraphProjectionWriter` gains `listDids`, implemented by `kvGraphProjections`.

  `MonitorRecheckRequest` (core) and `MonitorIngest.requestRefresh` queue a DID for refresh ahead of the usual order without making it due, at most a quarter of a batch; `monitorRecheck(env)` (cloudflare) is the relay's `requestRecheck` for a bound monitor.

  Also exported, not yet implemented and not used by any route: the read signing-key reader, the paged summary (`more`, `truncated`), the PLC operation-log verifier and the DID-document read. They arrive in follow-up releases.

- [#42](https://github.com/germ-network/atproto-pmr/pull/42) [`325717c`](https://github.com/germ-network/atproto-pmr/commit/325717cf40735670572bed212758d731b7d5e808) Thanks [@germ-mark](https://github.com/germ-mark)! - Keep a relay's cached did:plc signing keys current from the PLC directory's export stream.

  New optional env var on the monitor: `PLC_EXPORT_STREAM_URL`. Unset, nothing changes except that identity events now owe a cache delete for every watched DID; set, `MonitorIngest` holds a second outbound socket, resumes from a stored `seq` (or the tip), and applies each op for a watched DID to the `sk:` cache. For `did:plc` the stream replaces the Jetstream identity hint, which then covers other DIDs only.

  New in monitor: `decodePlcExportFrame`, `intakePlcEvent`, `drainKeyUpdates`, `plcCursorAfterClose`, the `KeyUpdateIndex` and `SigningKeyCacheWriter` interfaces, their `OwedKeyUpdate`, `PlcExportEvent`, `SigningKeyUpdate`, `PlcCursorAction`, `PlcIntakeDecision` and `DrainKeyUpdatesDeps` types, `IngestDeps.keyUpdates`. `MonitorIngest` gains the `KeyUpdateIndex` methods.

  New in monitor-cloudflare: `kvSigningKeyCache`, the `sk:<did>` adapter for the relay's cache and the consumer.

- [#35](https://github.com/germ-network/atproto-pmr/pull/35) [`93f5727`](https://github.com/germ-network/atproto-pmr/commit/93f57278ba7f41fcf5bf535a91b969784f7bcc62) Thanks [@germ-mark](https://github.com/germ-mark)! - Interfaces for the PMR proxy-cache model: per-collection record snapshots, the follow-edge and DID-document stores, the watched-set configuration, and the device read response bodies.

  New: `RecordSnapshotStore`, `StoredRecordSnapshot`, `FollowEdge`, `FollowEdgeStore`, `DidDocument`, `DidVerificationMethod`, `DidService`, `DidDocumentSource`, `CachedDidDocument`, `DidDocumentCache`, `WatchedRecord`, `WatchedDidSet`, `WatchedCollection`, `parseMonitorCollections`, `RecordReadMiss`, `RecordReadResponse`, `GraphEdge`, `GraphReadResponse` with their `*_KEYS` constants, `DECLARATION_COLLECTION_NSID` (core); `snapshotKeys` (monitor-cloudflare).

- [#40](https://github.com/germ-network/atproto-pmr/pull/40) [`010eb81`](https://github.com/germ-network/atproto-pmr/commit/010eb81ac3137817ff592ea5e3ca77da1ba9e91a) Thanks [@germ-mark](https://github.com/germ-mark)! - The relay's `KVDirectory` tells an optional monitor about registrations: `create` calls `register(did)` (also for an already-present DID), `delete` calls `unregister(did)`. Reached through the optional `MONITOR_INGEST` Durable Object namespace and `MONITOR_INGEST_NAME`; best-effort, logged and never failing the write, and a no-op when unbound. New in core: the structural `MonitorRegistrationNotify` interface.

- Updated dependencies [[`141af0d`](https://github.com/germ-network/atproto-pmr/commit/141af0d9f32ffbce2736eec9d62eb4bd16205dee), [`43de8ae`](https://github.com/germ-network/atproto-pmr/commit/43de8aecece665eb7b88494d8c590a44ab49a726), [`e51f69c`](https://github.com/germ-network/atproto-pmr/commit/e51f69c92c23fe5ef4d8b511e1f8dc6756fb9fbf), [`35c650e`](https://github.com/germ-network/atproto-pmr/commit/35c650e75818ced2812e3797f5adc4057083fb70), [`8c90282`](https://github.com/germ-network/atproto-pmr/commit/8c90282588d42add175511763b32124a9916295f), [`45971f2`](https://github.com/germ-network/atproto-pmr/commit/45971f28cedea6ce4cab9b72c2330716e47588a6), [`d6b4fda`](https://github.com/germ-network/atproto-pmr/commit/d6b4fdac6cac4bf1105279c3f91e4ce61cc97a50), [`ebb0fa0`](https://github.com/germ-network/atproto-pmr/commit/ebb0fa0f3b4412154874e4972047325952a57b5b), [`325717c`](https://github.com/germ-network/atproto-pmr/commit/325717cf40735670572bed212758d731b7d5e808), [`93f5727`](https://github.com/germ-network/atproto-pmr/commit/93f57278ba7f41fcf5bf535a91b969784f7bcc62), [`559f60f`](https://github.com/germ-network/atproto-pmr/commit/559f60fdac31cdf1b93a4be122e1ba951483384d), [`010eb81`](https://github.com/germ-network/atproto-pmr/commit/010eb81ac3137817ff592ea5e3ca77da1ba9e91a), [`2721824`](https://github.com/germ-network/atproto-pmr/commit/2721824adb9222fafe0c81d81d8d0a4afef852a5)]:
  - @germ-network/atproto-pmr-core@0.1.5

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

- Updated dependencies [[`450cf43`](https://github.com/germ-network/atproto-pmr/commit/450cf43977fa8884848a4eb098711d9cb5ddbb69)]:
  - @germ-network/atproto-pmr-core@0.1.4

## 0.1.3

### Patch Changes

- [#30](https://github.com/germ-network/atproto-pmr/pull/30) [`f47481b`](https://github.com/germ-network/atproto-pmr/commit/f47481b01861138be218e5ac3025ea35be10f5e1) Thanks [@germ-mark](https://github.com/germ-mark)! - Re-registration with a different anchor key now deactivates and replaces the prior registration instead of refreshing the stored key in place. Same-key re-registration is unchanged (idempotent in-place refresh).

- Updated dependencies [[`f47481b`](https://github.com/germ-network/atproto-pmr/commit/f47481b01861138be218e5ac3025ea35be10f5e1)]:
  - @germ-network/atproto-pmr-core@0.1.3

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

- Updated dependencies [[`bbaccf8`](https://github.com/germ-network/atproto-pmr/commit/bbaccf810ca951b18eaab9cd53320eb09b0bb324)]:
  - @germ-network/atproto-pmr-core@0.1.2

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

### Patch Changes

- Updated dependencies [[`ade4873`](https://github.com/germ-network/atproto-pmr/commit/ade4873f39246c0dd9d5ac10435d0bd3880b292a)]:
  - @germ-network/atproto-pmr-core@0.1.1
