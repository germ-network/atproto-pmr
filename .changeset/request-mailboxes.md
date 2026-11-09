---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
---

Replace the recovery pool, `prov`/`disc` adjudication and the discard window with per-sender request mailboxes. A put from a sender that is not blocked and that receive-time admission does not admit (or any sender without a pair mailbox when no admission source is bound) is held in that sender's request mailbox: it refuses with `429` at the sender's depth, keeps nothing and still answers `202` when the shared byte quota is full, never wakes the device, and exists only while it holds an entry. Admission `yes` moves the sender's request entries into its pair mailbox oldest first. The owner lists request mailboxes with `GET /pmr/v1/requests` (`handleRequestsList`, `{rq: [{k, id}], n}`) and reads and acks entries through the existing fetch-one and ack routes. A blocked sender's synthetic capacity now follows the tier its put would meet, and blocking clears request entries.

Removed: `GET /pmr/v1/pool` and `POST /pmr/v1/pool/adjudication` (`handlePoolList`, `handlePoolAdjudication`), the `#pool` events frame, the `t: "p"` push payload, `PMRStore.appendToPool`, `poolSenders`, `provisionFromPool`, `discardFromPool` and `setDiscarded`, `PoolLimits`, `OwnerDeps.discardWindowSeconds`, the device-contact bypass and the admitted mark, and the Cloudflare `POOL_*` variables. `PMRConfig.pool` becomes `PMRConfig.requests`, and the Cloudflare adapter reads `REQUEST_DEPTH_PER_SENDER` and `REQUEST_SHARED_CAP_BYTES`. Old pool, verdict, discard and admitted keys in a Durable Object are never read.
