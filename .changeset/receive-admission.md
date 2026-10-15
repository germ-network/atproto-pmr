---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

A pair put is judged when it arrives: does the hosted recipient accept this sender? The relay routes it in one `PMRStore.receive` call: delivered to an admitted mailbox, pooled with the verdict's reasons, or handled as from a blocked sender. The recipient's Bsky blocks are mirrored into the relay block at accept and at each catch-up. Every outcome stays a `202` or `429`.

Added: `PairPutDeps.admission` (`AdmissionSource`, `admissionOrUnavailable`, `admissionOf`), `PMRStore.receive`, `syncBskyBlocks` and `listBskyBlocked`, `block(key, now, source)`, `syncOwnerBlocks`, `EventsDeps.blocks` and `OwnerDeps.blocks`, and `d1AdmissionSource` in monitor-cloudflare. `d1SenderGraphReader` and `d1BlockEdgeStore` now take `Pick<D1Database, "prepare" | "batch">`. `GET /pmr/v1/pool` entries gain `v` and `r` for a sender the relay judged, and `GET /pmr/v1/blocks` gains `bs`. A yes admitted only by `open` is held back and pools as unknown until a relay bounds admitted senders.

When deploying, pass `admission: d1AdmissionSource({ db, snapshots })` in the pair-put deps and `blocks: monitorOwnBlocks(env)` in the owner deps. The relay Worker then needs bindings to the monitor's D1 database and records KV; it only reads them (graph reads go through a D1 session that may be served by a replica), but D1 has no read-only binding. Without `admission`, puts behave as before.
