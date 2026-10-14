---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor keeps an allow list (`INTEREST_POLICY`: `registered`, the default, or `everyone`) and snapshots the records in `MONITOR_COLLECTIONS` (for example `app.bsky.actor.profile/self`) quietly for every DID on it: no digest-window entry, no push. DIDs join and leave with an epoch check, KV first and then the index; the head check runs per DID (hourly for holders, `REFRESH_NONHOLDER_STALE_AFTER_MS`, default 24 h, for DIDs that hold no declaration); under `registered` the declaration socket ignores commits for DIDs outside the list. These are patch bumps on purpose: the packages are pre-1.0, and a minor would cascade all four packages to 1.0.0.

Deploy breaks:

- The default policy is `registered`, which requires a `pmrDirectory` KV binding and fails at startup without one. A deployment that watches every declaration holder (the Germ deployment) must set `INTEREST_POLICY=everyone` before taking this release; `pmrDirectory` is then optional.
- New settings: `INTEREST_POLICY`, `MONITOR_COLLECTIONS`, `REFRESH_NONHOLDER_STALE_AFTER_MS`, `UNREGISTER_GRACE_MS`, `INTEREST_BATCH`, and the `pmrDirectory` binding. Unset `MONITOR_COLLECTIONS` keeps no secondary.
- The ingest object adds `interest`, `interest_transitions`, `reg_state` and `rec_pending` tables and a `pending.quiet` column; under `everyone` every held holder is seeded into the list on first start.
- `IngestDeps.interest` is required; `IngestConfig.policy` is required; `PendingFetch.quiet` is required; `RefreshDeps.secondary` and `refreshDue`'s `nonHolderStaleAfterMs` are required; `RefreshIndex.dueRefresh` takes a third argument.
- `MonitorIndex` gains `completeQuietly` and an optional `quiet` argument on `completeDeletion`; `InterestIndex.forgetLeft` takes only the DID; `SecondaryIndex` gains `forgetSecondaries`; `SettleOutcome` gains `"left"`.
- `fetchRecordAt`/`verifyRecordAt` on the ingest object have working defaults over the global `fetch`; override them where the declaration's fetch is overridden.
- The ingest object's `register`, `unregister` and interest methods are RPC-callable by anything holding a `MONITOR_INGEST` binding. That is acceptable under one operator.
