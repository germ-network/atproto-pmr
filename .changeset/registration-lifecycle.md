---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

A registration the monitor's verified view shows is for a different anchor, or whose declaration is verifiably gone, becomes inactive: it accepts no new mail, keeps its backlog unread for 30 days, and is then destroyed (new `MonitorVerifiedAnchorRequest`, `applyVerifiedAnchorObservation`, `KVDirectory.deactivate`). A paused registration now queues mail instead of dropping it. Deregistration tombstones the anchor, which then cannot register again. Deployments call `monitorVerifiedAnchor` + `applyVerifiedAnchorObservation` from their recheck path.
