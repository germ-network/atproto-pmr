---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

The relay's `KVDirectory` tells an optional monitor about registrations: `create` calls `register(did)` (also for an already-present DID), `delete` calls `unregister(did)`. Reached through the optional `MONITOR_INGEST` Durable Object namespace and `MONITOR_INGEST_NAME`; best-effort, logged and never failing the write, and a no-op when unbound. New in core: the structural `MonitorRegistrationNotify` interface.
