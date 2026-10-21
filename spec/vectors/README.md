# Test vectors

## ml-dsa-65.json

Known-answer vectors for the ML-DSA-65 request-signing key described under
[Key material](../wire-api.md#key-material) in `wire-api.md`. They are
produced and checked by `gen-ml-dsa-65.sh` using OpenSSL alone (no code from
any implementation of this specification), so an implementation can test
itself against them without them resting on it.

Generated with OpenSSL 3.6.2 (`ML-DSA-65` needs 3.5 or later). All byte
strings are lowercase hex unless the field name says base64 or base64url.

| Field | Meaning |
| --- | --- |
| `context` | The ML-DSA context string used throughout: empty. |
| `rfc9964_figure7` | RFC 9964 Appendix A, Figure 7 (ML_DSA_65): the all-zero `seed`, its `pub`, and the COSE_Key `kid`. Copied from the RFC text. Keygen from the seed must give `pub`, and the thumbprint of `{1: 7, 3: -49, -1: pub}` must give `kid`. This is not the project key. |
| `key.seed` | The 32-byte private key (RFC 9964 §4). |
| `key.pub` | The 1952-byte public key. |
| `key.cose_key` | The COSE_Key: `a3 01 07 03 38 30 20 59 07 a0` followed by `pub`. |
| `key.thumbprint_input` | The bytes the thumbprint hashes; identical to `cose_key`, since the required parameters are all the key carries. |
| `key.thumbprint_hex`, `key.thumbprint_b64url` | SHA-256 of `thumbprint_input`, in both encodings. The vector request uses base64url as `keyid`; the spec does not fix the text encoding of `keyid`. |
| `request` | A signed registration request: `method`, `url`, `body_hex`, `content_digest`, `nonce`, `created`, `keyid`, `alg`, the `signature_input` field value, and the exact `signature_base` (no trailing newline). |
| `valid[]` | Signatures that verify over `request.signature_base` under `key.pub` with the empty context. |
| `invalid[]` | Signatures that must be refused, each with a `why`. `alg-relabelled` carries its own `signature_input` and `signature_base` for the relabelled request. |

The valid signature is made with OpenSSL's `deterministic:1`, which uses
all-zero signing randomness so it can be a fixed answer. Treat it as
verify-only for other implementations: ML-DSA signing is hedged by default,
and a hedged signer will not reproduce these bytes.

### Re-running

```sh
OPENSSL=/opt/homebrew/bin/openssl sh spec/vectors/gen-ml-dsa-65.sh --check
```

regenerates the file in a temporary directory and fails if it differs from
the committed one. Without `--check` it rewrites `ml-dsa-65.json`. The script
also stops if keygen or the thumbprint disagrees with RFC 9964 Figure 7, if
the SubjectPublicKeyInfo header is not the RFC 9881 §2 ML-DSA-65 header, or
if OpenSSL's verify results differ from what each vector declares. A
mismatch is a finding to investigate, never a reason to edit a vector.
