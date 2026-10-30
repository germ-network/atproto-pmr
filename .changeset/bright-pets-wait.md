---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Schedule bounded declaration settlement promptly after durable intake, preserve maintenance recovery, and guard failure deferral by the generation captured for each fetch. The SETTLE_BATCH default/cap of 32 applies to owed declarations per prompt wake and ordinary secondary records per maintenance wake; own-block proofs retain their separate budget. Declaration backlogs continue on prompt alarms, while secondary backlogs continue on maintenance wakes. A declaration no-progress cooldown also delays fresh declaration work and maintenance's declaration-settlement step, capped at the watchdog interval or 120 seconds when disabled, while unrelated maintenance and key work remain independent.

The monitor adds the public `IntakeDecision` value `key-update` for identity events that owe a signing-key-cache update without a declaration fetch. Consumers should handle the new outcome and schedule the wake/cursor work it represents. `MonitorIndex` adapters must return the active pending generation from `owedGenOf`, return `null` when no obligation exists, and make `deferPending` with an expected generation a no-op when it is null or mismatched so a newer obligation cannot be deferred by an older fetch.
