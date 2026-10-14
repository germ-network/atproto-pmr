---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor gains the follow-edge index in D1: a schema in `migrations/`, a writer the ingest object drives, the read surfaces `d1FollowEdgeStore`, `d1GraphChangeLog` and `d1InterestReader`, and an alarm step mirroring who is served, who holds a declaration and who is in interest. No graph is served yet: a graph owner is served only once its follows are listed, which comes later. Breaking for deployments: the ingest object now requires a D1 binding `graph` with the migrations applied, under both interest policies, and fails at startup without it. A patch bump because the packages are pre-1.0 and a minor would cascade to 1.0.0.
