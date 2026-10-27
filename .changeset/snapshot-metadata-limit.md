---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Keep a declaration snapshot's KV metadata under Cloudflare's 1024-byte cap. Since summary evidence and the messaging-key fields were added, a declaration carrying evidence could exceed it, so its put failed with a 413 and the monitor kept serving the previous snapshot. The stored evidence now omits what the metadata and the DID already hold and is rebuilt on read; snapshots stored in the older shape still read as before, so no migration is needed. If the metadata still exceeds the cap, `writeEntry` drops the evidence, then the messaging key's first-seen time, then its fingerprint, and logs `monitor: snapshot metadata trimmed`. A DID the refresh pass fails on now logs `monitor: refresh did failed` with the error.
