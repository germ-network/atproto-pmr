---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

Pair puts retain one independently verified declaration proof per sender-specific mailbox generation. Confirmed sender-key changes recycle only that sender's queued and pooled messages; pair deliveries carry generations and stale acknowledgements cannot remove replacement-generation messages. The owner read API exposes the selected proof by exact declaration CID. Custom PMRStore adapters must implement the pair-generation operations before adopting this release.
