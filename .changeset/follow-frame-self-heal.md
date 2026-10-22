---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

A follow-stream frame whose handling throws no longer loses its edge silently. It is still never retried and never holds the cursor, but its author's follow listing is queued again when the DID is in interest (a follow, block, `#sync` or active `#account` frame; a listing already running keeps its progress and a fresh one follows it), so the lost follow or block edge is usually repaired at the next listing. The failure is logged as `monitor: follow frame failed` with the error's name, message and a truncated stack plus the event's kind, DID, cursor and, for a commit, collection, operation and rkey; a failed relist is logged as `monitor: follow frame relist failed` and a failed counter write as `monitor: follow frame failure count failed`. `ingestStatus()` gains `followFrameFailures` (`count`, `lastAtMs`, `lastErrorName`; additive, not a spec surface). `ListingQueueReason` gains `lost-frame`.
