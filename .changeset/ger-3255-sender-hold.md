---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
---

Hold a pair put from a sender whose new declaration the key monitor has not yet settled. A put that fails under the monitor's snapshot but verifies under the declaration on the sender's PDS is answered `202` instead of `409`, and delivered when the monitor settles a declaration whose key verifies it, so a user who just signed in on a new device can message right away. The PDS read only admits a put to wait; delivery still rests on the monitor's declaration. Opt in with `PairPutDeps.senderHold`, a `SenderHoldObject` subclass bound as `SENDER_HOLDS`, and `releaseSenderHold` in the monitor's `onSettled`; without them a failing put still answers `409`. The spec describes the hold, and the conformance summary now lists `409` for a pair put.
