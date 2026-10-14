---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor verifies every fetched CAR at ingest against the signing key of the DID document fetched with it, and stores nothing that does not verify. These are patch bumps on purpose: the packages are pre-1.0, and a minor would cascade all four packages to 1.0.0.

Deploy breaks:

- `IngestDeps.verify` is required and returns a `VerifyOutcome`.
- `FetchedRecord.rev` is removed; the rev now comes from the verified commit.
- `SnapshotEntry.verifiedWith` and `cid` are required on write.
- `fetchHeadRev` (the exported function, `RefreshDeps.fetchHeadRev` and the protected method) returns `{ rev, signingKey }`, and the key must be in the form `fetchRecord` returns.
- `SettleOutcome` gains `"unverifiable"`.
- A deployment `fetchRecord` that returns `signingKey: null` stores nothing.
- `MonitorIndex` gains `markAttempted`, `isWatched`, `recordsOf` and `holderStateOf`, and `complete`/`completeQuietly` take the verified CID and key.
- The ingest object adds `records` (starts empty) and `holder_state` (seeded once from existing rows). Over the first refresh cycle each held snapshot is re-verified, quietly when its CID and key are unchanged.
