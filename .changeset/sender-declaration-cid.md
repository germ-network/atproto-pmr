---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

The relay pins the sender's declaration CID, and verifies it from the monitor instead of the sender's PDS.

Fix: the anchor key algorithm byte for Ed25519 signing is `3`, not `2` (the identifier table omitted AES-GCM-256 at index 0). This is a pre-existing bug: the relay rejected every real declaration.

Breaking:
- The delivery hint is `sd` + `dc` and no longer carries `kt`. `dc` is the declaration record's CID (CIDv1, dag-cbor, sha2-256, base32 lower, `bafyrei…`) and is a freshness cue, not a trust signal. `VerificationHint.anchorKeyThumbprint` is replaced by `declarationCID`; a stored hint without one emits no hint. This applies to `#delivery`, `GET /pmr/v1/messages` and full-form push.
- `PairPutDeps.resolveDeclaration` returns `SenderDeclarationResolution` (anchor key plus `declarationCID`). Wire `snapshotDeclarationResolver` (with `kvDeclarationSnapshots` and `cachedSigningKeyResolver`) for senders; the PDS resolver is now for owner-DID reads only.
- A pair put whose sender declaration is unknown, stale or unverifiable, or whose signature fails under the resolved key, answers `409` with `Retry-After` and stores nothing. A validly signed put to an unknown or different recipient still answers `202`.
- `VerifyOutcome`'s failure arm gains `code: "signature" | "recipient"`.
- `fetchLatestRev` takes optional terminal-error names.

New:
- `verifyRecordProof` / `readRecordFromCar`: single-record repo proofs (CAR, commit signature, MST path).
- The monitor re-confirms every held snapshot on its alarm, storing advances with an unchanged declaration quietly, and the relay treats a snapshot older than `SNAPSHOT_MAX_AGE_MS` (6 h) as unknown. `MonitorIngest` gains a `checks` table and `fetchHeadRev`; `kvDeclarationSnapshots` serves `{car, freshAtMs}`.
- New monitor env vars `REFRESH_BATCH` and `REFRESH_STALE_AFTER_MS` (defaults 64 and 3600000, set in `wrangler.example.toml`; declare them in the env type).
