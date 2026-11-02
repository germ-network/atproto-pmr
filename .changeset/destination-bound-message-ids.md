---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Bind message ids to their destination mailbox, so a recycle in one mailbox can no longer delete a body held for another. `deriveMessageId` is removed: use `messageIdFor({ locator, key }, payload)` for message ids and `typedDigest(bytes)` for plain content addresses. `MessageId` is now a branded type that only `messageIdFor` and `messageIdFromWire` produce, and `BodyStore` and `PMRStore` take it. The spec now requires ids to bind their destination and body stores to scope every operation to one mailbox.
