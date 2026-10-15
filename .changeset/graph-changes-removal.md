---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The follow-edge index no longer keeps a change log. Nothing read the D1 `graph_changes` table once the graph projector left, yet every edge, holder and served change wrote rows into it that the alarm then pruned.

Removed: `GraphChangeReason`, `GraphChangeRow` and `GraphChangeLog` (core); `d1GraphChangeLog`; `pruneGraphChanges`, `GRAPH_CHANGE_RETENTION_MS` and `FollowEdgeWriter.pruneChanges` (monitor); the `GRAPH_PRUNE_BATCH` variable, which can be dropped from the Worker config. The writers send fewer statements, so the budgets are smaller: a mirrored DID takes 5 statements (was 11), a flushed chunk of 25 follow creates 2 (was 5) and of deletes 1 (was 3), a drained chunk 2 (was 4). One alarm clears about 4,950 listed edges (was 2,450).

Schema: `0001_follow_graph.sql` no longer creates `graph_changes`; it is edited in place, so a D1 that has not applied it needs nothing. A D1 that already applied 0.1.5's `0001` keeps an orphan table: `DROP TABLE graph_changes`.
