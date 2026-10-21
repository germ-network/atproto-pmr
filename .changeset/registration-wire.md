---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-cloudflare": patch
---

`POST /pmr/v1/registrations` now answers `409` (empty body, terminal) when a verified create names a tombstoned anchor, instead of `401`. `GET /pmr/v1/registration` returns `st`, `"active"` or `"paused"`.
