---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Package logs no longer carry a DID, an error message, a stack or a response body: failure lines log the error's class name only (`errorKind`), and DID-keyed lines drop the DID. Settle failures keep their full detail in `last_failure`, as before.
