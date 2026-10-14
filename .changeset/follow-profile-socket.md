---
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

The monitor keeps a second Jetstream socket for follows and the `MONITOR_COLLECTIONS` records, with its own cursor. Follow changes by graph owners and registered users, and `#sync`/`#account` re-listing requests, are logged for the edge index that comes later; a live profile commit for a DID in interest owes a fetch. Breaking for custom code: `CommitEvent.subject` and `IdentityEvent.active`/`status` are now required, and `clearSecondary`/`completeSecondary`/`disposeSecondary` take the owed rev. A patch bump because the packages are pre-1.0 and a minor would cascade to 1.0.0.
