---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

No route, store or job publishes a follow graph, and the summary carries none.

Removed: `GET /pmr/v1/graph/{did}` (`handleGraphRead`), the `graph:<did>` KV projection (`kvGraphProjections`), the graph projector (`runGraphProjector`, `GRAPH_PROJECTOR_BATCH` and its types), the projection store types (`GraphProjectionStore`, `GraphProjectionWriter`, `GraphReadDeps`), `projectGraph`, and the graph wire types and codecs (`GraphReadResponse`, `GraphEdge`, `GRAPH_READ_KEYS`, `GRAPH_EDGE_KEYS`, `encodeGraphReadResponse`, `decodeGraphReadResponse`). The summary no longer has `g` (`SummaryDelta.graph`; the key is retired), and the stored baseline holds the owner's DID instead of a graph. Devices read the record and DID-document routes and the owner's summary only.

The summary chooses its contacts privately: the ingest object answers `ownGraph(did)` over RPC (`MonitorOwnGraphRequest`, one D1 batch via `FollowEdgeStore.ownEdges`), and a relay passes `graph: monitorOwnGraph(env)` in its summary deps instead of `projections`. A summary poll now makes two ingest RPCs (`ownGraph` and `ownBlocks`) where it made one KV read. `409` now means the owner's graph is not served yet; a failed graph or blocks read answers `503`. `SummaryOwnBlocksError` is now `SummaryOwnerReadError`, and `FollowEdgeStore.following`/`followers` are replaced by `ownEdges`; core exports `ownerGraph`, `OwnerGraph` and `OwnerGraphEdge`. When deploying, unmount the graph route, remove `GRAPH_PROJECTOR_BATCH` from the Worker config, and delete any `graph:<did>` keys left in the records KV.
