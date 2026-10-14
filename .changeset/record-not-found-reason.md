---
"@germ-network/atproto-pmr-core": patch
---

`RecordNotFoundError` carries `reason`, the XRPC error name that confirmed the state (`RecordNotFound`, `RepoNotFound`, `RepoTakendown`, …), or null when it was confirmed by message prefix (a did:plc tombstone). Only `RecordNotFound` is record-level; callers treat anything else, null included, as the repo or DID being gone. The constructor takes it as an optional third argument.
