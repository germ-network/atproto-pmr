---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-monitor": minor
---

Support signed mailbox/monitor registration bundles with mailbox-first partial acknowledgements and a stored-key-preserving monitor composition hook. Bound the post-mailbox monitor wait to a configurable five seconds, retain late attempts through a deployment lifetime hook, and return unresolved on expiry. Legacy registration and independent monitor lifetimes remain unchanged.
