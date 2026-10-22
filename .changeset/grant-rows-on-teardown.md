---
"@germ-network/atproto-pmr-cloudflare": patch
---

Replacing, retiring or deregistering a registration now deletes its grant-address rows from the directory instead of leaving them to lapse on their TTL. A sender's put to a removed address is unchanged: still 202 with identical bytes. The deletion is best-effort and never fails the removal.
