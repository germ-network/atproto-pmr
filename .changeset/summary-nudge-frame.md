---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Add a payload-free `#summary` frame on the events socket: a hint that an owner's social graph or summary inputs may have changed, sent only to attached sockets and never as backlog. Clients MUST ignore frames whose type they do not recognize. `PMRObject.nudgeSummary()` sends it, coalescing bursts into a leading and a trailing frame per `summaryNudgeIntervalMs`. `MonitorIngest.onSummaryInputsChanged` reports each committed declaration change and graph write, and `summaryOwnersAffected` resolves a report to the graph owners whose summary it may have altered.
