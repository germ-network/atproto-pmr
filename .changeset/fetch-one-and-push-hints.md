---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Add `GET /pmr/v1/messages/{k}/{id}`: an owner-authenticated fetch of one queued message, returned as its catch-up entry, without acking it. Every miss gets the identical `404`. Core exports `handleMessageRead`, `parseMessageReadPath`, `messageMissResponse`, `readMessageEntry` and `messageEntryFields`. `PMRStore.getMessage` is a new required member, so other `PMRStore` implementers must add it.

The `{t:"d"}` own-DID push now carries a `c` hint (`rev`, `rotate` or `gone`) and, when the monitor verified a record on that change, a `dc` hint. Hints never replace the device's own verification. `IngestDeps.onChange` gains an optional trailing `hint`; a subclass that overrides `onChange` without forwarding it sends a bare `{t:"d"}`, which still means a change of unknown kind.
