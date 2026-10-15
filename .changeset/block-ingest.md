---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

The monitor ingests `app.bsky.graph.block` records and serves an owner their own block list through the authenticated summary.

Blocks of a served graph's owner, and a non-owner in interest's blocks of registered DIDs, are kept in a new D1 `blocks` table (migration `0002_blocks.sql`; apply it before deploying) beside the follows. They arrive on the follow socket, which now subscribes to the block collection (a one-time change of its URL), and listings read them with the follows: owner repos verify both collections in one `getRepo` pass (`verifyRepoCollections`, each under its own cap, with the new optional `MAX_BLOCKS`), paged and mutual listings page follows then blocks. A DID's blocks are pruned with its follows. Blocks are not projected or served publicly, since no device reads other DIDs' block lists and serving them would cost; they have no projection or route.

The owner's summary carries their own blocks under `b` (`SummaryDelta.ownBlocks`, null when unchanged). The ingest object answers `ownBlocks(did)` over RPC (`MonitorOwnBlocksRequest`), and a relay passes `blocks: monitorOwnBlocks(env)` in its summary deps; a failed read answers `503`, an unserved graph `409`. `BlockEdgeStore.isBlocked` answers whether one DID's kept block names another. `MONITOR_COLLECTIONS` now refuses the follow and block collections.
