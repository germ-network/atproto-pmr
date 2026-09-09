# @germ-network/atproto-pmr-monitor

## 0.1.3

### Patch Changes

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

- Updated dependencies [[`ade4873`](https://github.com/germ-network/atproto-pmr/commit/ade4873f39246c0dd9d5ac10435d0bd3880b292a)]:
  - @germ-network/atproto-pmr-core@0.1.1
