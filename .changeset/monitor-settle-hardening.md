---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

A secondary record's failed settle is no longer silent: the failure stays on its `rec_pending` row (with when it was first owed), each deferral logs `monitor: secondary settle deferred`, retries back off up to the declaration's retry cap (the DID's refresh interval where it has one), and one failing record no longer ends the batch. `ingestStatus()` gains `secondaryPending` and `gonePermanent` (additive; not a spec surface). `RecordNotFound` is now reversible, since an account can publish the record again; only `RepoNotFound` (and a PLC tombstone) stays permanent, and a reversible answer lifts a DID's deleted mark. A repeated gone answer is recorded quietly, and a DID returning from gone is announced even at an unchanged rev. Every DID marked deleted before the upgrade is asked once more (expect `pending` to spike once after deploy), and a migrated DID answering with a signed exclusion proof can retire its relay registration. `SecondaryIndex.deferSecondary` now takes the failure and answers the stored attempts.
