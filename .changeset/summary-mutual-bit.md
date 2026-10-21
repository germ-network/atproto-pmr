---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

Each `c` entry of the owner's summary carries `u`, whether the contact is a mutual follow (`SummaryVerdict.mutual`, key `SUMMARY_VERDICT_KEYS.mutual`). It is always encoded, a CBOR boolean, and an entry is re-sent with a new token when only its mutual bit changes. A contact with no verdict has no entry, so its mutual bit is not sent. Summary baselines stored before this change re-send every verdict once. A client that has never held `u` must read once without `since`; an entry with no `u`, from a relay that predates it, reads as not mutual. The mutuals-first tier of the contacts a summary covers now reads a mutual edge from either the following or the followers list, the same set that sets `u`.
