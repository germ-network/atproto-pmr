---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
---

Declaration watch: add the monotonic-rev watermark.

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
