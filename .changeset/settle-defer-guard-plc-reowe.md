---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

`settleDue` no longer abandons the rest of its batch when recording one DID's deferral fails (`deferPending` or `retryCapMs` throwing): the failure is logged as `monitor: settle defer failed` with the DID, that row stays due as it was, and the remaining DIDs settle. A live answer for a DID marked deleted by a permanent answer (a commit, refresh or quiet settle through `complete` or `completeQuietly`) now lifts the mark the way a reversible answer does: a watched did:plc is owed its PLC log again at once, rather than only when its interest membership flips.
