---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Add monitor evidence for declaration summaries. Evidence binds retained observation ages and a remaining recheck TTL to the exact declaration record, signed repository commit, verified key authority, assurance mode, and monitor hostname. Full custody-chain evidence is preferred; a fresh current-key/AppView/PDS cross-check is an explicitly weaker seed path. Summary records use compact CBOR durations, and legacy or unprovable evidence is explicitly unavailable.
