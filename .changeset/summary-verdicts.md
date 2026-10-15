---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

The owner's summary carries the owner's can-message verdict for each covered contact: changed verdicts under `c` (`SummaryDelta.verdicts`) and the contacts that lost one under `y` (`droppedVerdicts`). A contact with no servable declaration has no verdict, which is not a `no`.

Deployers must pass the new required `senderGraph` in the summary deps, `d1SenderGraphReader(<graph D1>.withSession())`, so the relay binds the monitor's D1; `d1SenderGraphReader` and `d1BlockEdgeStore` now accept a D1 session. A failed read of the contacts' graph facts answers `503` with `Retry-After`. A custom `SummaryIndexReader` must return a declaration entry's stored `policies` (`SummaryHeldEntry.policies`), or every contact reads `unknown [declaration-unavailable]`; `kvSummaryIndexReader` does. New exports: `indexPolicySource`, `SummaryVerdict`, `SUMMARY_VERDICT_KEYS`, and `D1Reader` in monitor-cloudflare. A summary poll makes one more set of D1 reads, through a replica session and not through the ingest object. Summary baselines stored before this change resend every verdict once, and a declaration stored before policies were kept reads `unknown [declaration-unavailable]` in the summary until the account's next repo commit rewrites it.
