---
"@germ-network/atproto-pmr-core": patch
---

`verifyRepoCollection` streams a `com.atproto.sync.getRepo` CAR and returns every record of one collection (for example `app.bsky.graph.follow`) with its rkey and CID and the signed rev. It verifies the commit signature against the DID document's signing key, hash-checks every block it keeps, and walks the collection's whole key range in the signed tree. Only the commit, MST nodes and candidate record blocks are retained, in any block order, under byte and node caps.

New: `verifyRepoCollection`, `RepoCollectionError`, `DEFAULT_MAX_REPO_BYTES`, `DEFAULT_MAX_MST_NODES`, `CollectionRecord`, `RepoCollectionErrorCode`, `RepoCollectionExpectation`, `VerifiedCollection` (core).
