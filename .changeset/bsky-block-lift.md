---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

Only a device unblock lifts a block the relay mirrored from Bsky. A Bsky unblock, an admitting verdict, or a block missing from a sync no longer lifts it; deployments that relied on a Bsky unblock clearing the relay block now need the device to lift it (`bs` in `GET /pmr/v1/blocks` lists the mirrored senders).
