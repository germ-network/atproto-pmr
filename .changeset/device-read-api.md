---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Device-facing read API handlers: public record and graph reads, and the owner's summary with `?since=` token deltas. Routes are wired by the deployment.

New in core: `handleRecordRead` (`GET /pmr/v1/records/{did}/{collection}/{rkey}`, with `RecordReadDeps.serves` gating which DIDs are served), `dedupedRecheck`, `projectGraph`, `handleGraphRead` (`GET /pmr/v1/graph/{did}`), `GraphProjectionStore`, `GraphProjectionWriter`, the record and graph response codecs, `handleSummaryRead` (`GET /pmr/v1/summary`), `buildSummary`, `diffSummaryIndex`, the summary codec with `SUMMARY_DELTA_KEYS` / `SUMMARY_RECORD_KEYS`, and `SUMMARY_TOKENS_KEPT`. Public reads are unauthenticated and `no-store`; a lapsed declaration is served as held and its re-check goes to `waitUntil`.

Breaking for custom stores: `PMRStore` gains `putSummaryIndex` / `getSummaryIndex`; `PMRObject` implements them.

New in monitor-cloudflare: `kvGraphProjections`, the KV store for graph projections under `graph:<did>`.
