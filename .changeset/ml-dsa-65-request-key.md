---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Request signatures may be made with an ML-DSA-65 key. `parseAkpMlDsa65Key`, `thumbprintAkpMlDsa65`, `parseCosePublicKey` and their encoders handle the AKP COSE_Key (RFC 9964); `verifyRequestSignature` takes a `CosePublicKey` (bare bytes stay Ed25519) and picks the algorithm from the key's type, requiring `alg` to be `ed25519` or `ml-dsa-65` to match; `requestSignatureAlg` exposes that mapping. `signRequest` accepts `key: SigningKey` for an ML-DSA-65 seed (hedged unless `deterministic: true`) alongside the existing `secretKey`. A bare key of the wrong length is now refused as "malformed key". `@noble/*` is pinned to 2.4.0 and `@noble/post-quantum` 0.7.1 is added; the anchor key and its endpoints are unchanged.
