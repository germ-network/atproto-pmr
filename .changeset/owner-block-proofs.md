---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Serve a registered owner's own `app.bsky.graph.block` records on the record route as monitor-held proof CARs, presence only. A deployment opts in by wiring `servesOwnBlocks` in `RecordReadDeps`, for example from `d1InterestReader(...).isRegistered`; until then every block read stays `not-watched`. The monitor fetches an owner's block proofs on live block commits and at listing completion under a new `OWN_BLOCK_SETTLE_BATCH` budget, and removes them when the owner is deregistered.
