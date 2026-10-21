---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor no longer swallows settle failures. Each deferral is logged as `monitor: settle deferred` with the DID, attempts and reason, and the pending row keeps when it was first owed and its last failure. Retries back off exponentially, capped at the DID's refresh interval (30 days where refresh does not cover it), and a new event for the DID resets the backoff. `MonitorIngest` gains read-only `ingestStatus()` and `pendingDetail(did)` for backfill and pending progress, and a throwing settle no longer skips the rest of the alarm. Non-terminal XRPC errors from the guarded fetches now carry the error name.
