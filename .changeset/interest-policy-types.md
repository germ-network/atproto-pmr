---
"@germ-network/atproto-pmr-core": patch
---

Interest-policy and consumer types for the proxy cache's allow list.

New: `InterestPolicy`, `parseInterestPolicy`, `GraphChangeReason`, `GraphChangeRow`, `GraphChangeLog`, `InterestReader`. `StoredRecordSnapshot` gains nullable `rev` and `cid`. `WatchedDidSet` is now `"interest"` (was `"declarations"`).
