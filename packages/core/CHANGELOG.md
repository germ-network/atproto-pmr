# @germ-network/atproto-pmr-core

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
