---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

`REQUEST_DEPTH_PER_SENDER` and `REQUEST_SHARED_CAP_BYTES` set the request-mailbox limits; unset, or not a positive integer, they default to 5 and 5000000 instead of leaving the tier unbounded (the old `POOL_*` variables are ignored). A request entry from a sender that already has a pair mailbox now stores and extends its proof, so `GET /pmr/v1/pair-evidence/{senderDID}` serves it while it is held. Request entries leave when their body expires, including those of a sender that also holds a pair mailbox and those held without a proof; a periodic sweep returns their bytes to the shared quota. `PMRObject` judges an entry by whether its body is still in the `messages` namespace; a deployment that stores bodies elsewhere must override `PMRObject.bodyStored`, or its request entries are dropped after five minutes.
