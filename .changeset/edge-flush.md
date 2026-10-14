---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor drains its logged follow changes into the follow-edge index, and keeps each DID's count of graph-owner followers in step with every edge write, so under the `registered` policy a registered user's followees join interest as they are followed. No graph is served yet. Deploy note: under `registered`, the first drain of the follow log kept since the follow/profile socket shipped joins every followee in that backlog at once; their quiet declaration and profile fetches follow over the next alarms, bounded by `SETTLE_BATCH`. A patch bump because the packages are pre-1.0 and a minor would cascade to 1.0.0.
