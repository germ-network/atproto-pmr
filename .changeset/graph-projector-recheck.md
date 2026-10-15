---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor keeps the public graph projections in step with the edge index, and a lapsed-declaration read can ask for an earlier refresh.

`runGraphProjector` (monitor) tails the edge index's change log from the alarm, re-projecting each served graph a row names, deleting the projection of one no longer served, and rebuilding when its cursor falls behind retention. `GRAPH_PROJECTOR_BATCH` (default 200) bounds the DIDs written per alarm. `GraphProjectionWriter` gains `listDids`, implemented by `kvGraphProjections`.

`MonitorRecheckRequest` (core) and `MonitorIngest.requestRefresh` queue a DID for refresh ahead of the usual order without making it due, at most a quarter of a batch; `monitorRecheck(env)` (cloudflare) is the relay's `requestRecheck` for a bound monitor.

Also exported, not yet implemented and not used by any route: the read signing-key reader, the paged summary (`more`, `truncated`), the PLC operation-log verifier and the DID-document read. They arrive in follow-up releases.
