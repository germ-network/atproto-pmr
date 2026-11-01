---
"@germ-network/atproto-pmr-cloudflare": patch
---

Do not schedule expiry alarms for zero-expiry pair-proof watermarks. Later blocked, discarded or duplicate puts preserve anti-rollback state without scheduling an invalid alarm or breaking the Durable Object input gate; live proof expiry and bounded scans remain unchanged.
