---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Follow listings for the follow-edge index: a graph owner's repo is read once with `getRepo`, verified, staged in the monitor's own storage and written to D1 across alarms; an owner past the walk's caps, and a non-owner's mutual hints, are listed by unverified `listRecords` pages.

New in core: `guardedFetchStream` (a streamed, guarded fetch raising `FetchTimeoutError` or `BodyTooLargeError`), and on `verifyRepoCollection` the `maxRecords` cap (`record-cap-exceeded`) and the `onRetained` report of what the read kept (`RetainedBlocks`).

Patch, not minor: the packages are pre-1.0 and a minor bump would cascade to 1.0.0. The monitor object's own SQLite gains tables and columns on first start; no D1 migration and no new binding.
