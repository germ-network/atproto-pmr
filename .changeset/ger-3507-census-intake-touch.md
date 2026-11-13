---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Three deployment seams, no wire-protocol change:

- `KVDirectory.listRouteCandidates` and `probeRegistration`: a read-only census probe that classifies each routed DID as live (with its `lastActive`) or excluded.
- `onIntakeStored` on the pair and grant put deps: called once per real stored intake, after the body write; its failures never change a response or delay delivery.
- Owner activity: `PMRStore.touchActive` (optional) and `utcDay` are new. `lastActive` now advances to the first authenticated owner interaction of each UTC day: an authenticated owner call, a socket frame, or a same-key registration POST. A registration refresh no longer writes it.

Transition: before this release `lastActive` was the time of the last registration create or refresh. Values written before the deploy carry that meaning.
