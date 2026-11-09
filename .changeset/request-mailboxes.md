---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
---

Replace the recovery pool, `prov`/`disc` adjudication and the discard window with per-sender request mailboxes. A put from a sender that is not blocked and that receive-time admission does not admit is held in its request mailbox: `429` at the sender's depth, `202` with nothing kept when the shared byte quota is full, and no wake of the device. Admission `yes` moves the sender's request entries into its pair mailbox, and a blocked sender's synthetic capacity follows the tier its put would meet. The owner lists them with `GET /pmr/v1/requests` (`handleRequestsList`) and reads and acks entries through the existing fetch-one and ack routes.

`PMRStore` adopters implement `appendToRequest` and `requestMailboxes` and handle the `held` and `dropped` `ReceiveResult` outcomes; `appendToPool`, `poolSenders`, `provisionFromPool`, `discardFromPool` and `setDiscarded` are removed, along with `GET /pmr/v1/pool`, `POST /pmr/v1/pool/adjudication`, the `#pool` frame, the `t: "p"` push payload, `PoolLimits` and `OwnerDeps.discardWindowSeconds`. `PMRConfig.pool` becomes `PMRConfig.requests`, and the Cloudflare adapter reads `REQUEST_DEPTH_PER_SENDER` and `REQUEST_SHARED_CAP_BYTES` instead of `POOL_*`.
