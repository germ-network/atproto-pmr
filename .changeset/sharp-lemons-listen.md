---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
---

Pair puts retain one independently verified declaration proof per sender pair while messages remain queued or pooled when its CAR fits the shared pool budget; a message is still pooled without proof metadata when the CAR does not fit. Pool-held proof bytes transfer out of the budget when the sender is provisioned. Confirmed sender-key changes recycle only that sender's queued and pooled messages while preserving replay protection; generation-aware acknowledgements protect replacement messages, and legacy message-ID acknowledgements remain supported. The owner read API exposes the selected proof by exact declaration CID. Custom PMRStore adapters must implement the pair-generation operations before adopting this release.
