---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Device reads serve the rev and CID ingest verified and fail closed on a rotated signing key, and the owner's summary is paged.

`handleRecordRead` takes `rev` and `cid` from the stored snapshot's verified metadata, and requires `RecordReadDeps.signingKeys`: a snapshot verified under a key other than the DID's trusted current key, or for a `did:plc` DID with no trusted key, reads `unverifiable`; `did:web` is served on its ingest verdict. `readSigningKeyFrom`, `servableUnderRotation` and `kvReadSigningKeys` (monitor-cloudflare) implement the trust rule: a cached document is trusted while the PLC stream has covered it continuously since its fetch, otherwise for ten minutes.

Wire change: the summary response gains `more` (`m`) and `truncated` (`n`); a decoder that ignores unknown keys is unaffected. A response carries at most `SUMMARY_PAGE_RECORDS` changed records; `handleSummaryRead` now takes `SummaryPageDeps` (`buildSummary` and `SummaryDeps` are removed) and `kvSummaryIndexReader` (monitor-cloudflare) builds the index from bulk metadata reads without reading any CAR. An owner's contacts are capped at `SUMMARY_MAX_RECORDS` over the watched count.

Breaking for custom stores: `PMRStore.putSummaryIndex` takes an optional `replaces` token. `PMRObject` stores each index in size-bounded parts.
