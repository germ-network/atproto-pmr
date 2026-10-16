---
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Fix the follow/profile/block Jetstream socket: send one `collections` parameter per collection instead of a comma-joined list, which Jetstream rejects with HTTP 400.
