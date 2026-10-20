---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

A new anchor key's registration retires the DID's prior registration to inactive instead of deleting it: the prior key keeps reading and acknowledging its own backlog for 30 days, then it is destroyed, and nothing else carries over. A paused registration now queues mail. Only the monitor's verified view makes a registration inactive (new `MonitorVerifiedAnchorRequest`, `applyVerifiedAnchorObservation`, `KVDirectory.deactivate`/`registrations`), and deregistration tombstones the anchor so it cannot register again. `Directory.delete` is removed. Deployments must pass `resolveRegistrations` to `authenticateOwner` and forward the events socket by the authenticated `locator`, never by DID.
