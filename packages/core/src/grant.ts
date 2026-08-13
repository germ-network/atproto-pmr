import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"

/**
 * Grant address and put-tag derivation — `spec/wire-api.md`, "Grant address
 * and put-tag derivation".
 *
 * Uses `@noble/hashes` rather than WebCrypto, for the same reason
 * `message-id.ts` does: it keeps this package free of any platform's crypto
 * global, and it lets these be synchronous, which matters because they sit
 * on the grant-put hot path.
 *
 * Two domain-separated HMAC-SHA256 derivations under one 32-byte `authKey`,
 * the symmetric key a grant issues:
 *
 *   address = HMAC-SHA256(authKey, "germ-pmr:grant-addr:v1" || host)
 *   tag     = HMAC-SHA256(authKey, "germ-pmr:grant-put:v1" || addressString
 *                                  || nonce || bodyDigest)
 *
 * The labels are distinct from germ-service's legacy v2 scheme
 * (`germ-addr:v1` / `germ-put:v1`) on purpose: that scheme belongs to the
 * anchor-key-indexed inbox this specification retires
 * (`spec/wire-api.md#not-yet-specified` — Q-PMR-8), and reusing its labels
 * here would let an authKey accidentally shared between the two systems
 * produce cross-valid values. `germ-pmr:` matches this package's own
 * existing convention (`PAIR_PUT_TYPE_VERSION`, in `cose/sign1.ts`).
 *
 * Byte representations are fixed so an independent implementation can
 * reproduce this exactly:
 *   - `host`: UTF-8 bytes of the hostname string, unencoded.
 *   - `addressString`: UTF-8 bytes of `address`'s base64url STRING form
 *     (unpadded — 43 bytes for a 32-byte HMAC output), not the raw bytes.
 *     Matches what travels in the URL path, so a verifier that only ever
 *     sees the string form still reproduces the tag.
 *   - `nonce`: UTF-8 bytes of the redeemed put-challenge's STRING form —
 *     the same value `ChallengeStore` keys on — not a re-decoding of it.
 *     `ChallengeStore` is string-typed throughout (`mint`/`consume` both
 *     take the challenge as a string), so treating it as bytes here would
 *     be a redundant, purely local re-encoding with nothing to check it
 *     against.
 *   - `bodyDigest`: the raw 32-byte SHA-256 digest of the exact message
 *     bytes, computed once and shared with `deriveMessageId`'s dedup use.
 * `addressString` and `bodyDigest` are fixed-length; `nonce`'s length
 * follows the deployment's own challenge `byteLength` once base64url-
 * encoded, constant within one deployment but not mandated across them.
 * Concatenation ambiguity is not a concern regardless: both sides always
 * know each field's length independently (the server redeems `nonce` by
 * exact string lookup and computes `bodyDigest` itself; neither is ever
 * recovered by splitting the concatenated HMAC input back apart), so
 * there is nothing here for a variable length to make ambiguous.
 */

const ADDRESS_LABEL = new TextEncoder().encode("germ-pmr:grant-addr:v1")
const PUT_LABEL = new TextEncoder().encode("germ-pmr:grant-put:v1")

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.byteLength
    }
    return out
}

function requireHmacKey(authKey: Uint8Array): void {
    if (authKey.byteLength !== 32) {
        throw new Error(`Grant authKey must be 32 bytes, got ${authKey.byteLength}`)
    }
}

/** The 32-byte address this grant's `authKey` derives, scoped to `host`. */
export function deriveGrantAddress(authKey: Uint8Array, host: string): Uint8Array {
    requireHmacKey(authKey)
    return hmac(sha256, authKey, concat(ADDRESS_LABEL, new TextEncoder().encode(host)))
}

/**
 * The tag a grant put carries, authenticating a body whose digest is
 * `bodyDigest` against `authKey`, scoped to `addressString` and bound to
 * `nonce` (the redeemed put-challenge).
 */
export function computeGrantPutTag(
    authKey: Uint8Array,
    addressString: string,
    nonce: Uint8Array,
    bodyDigest: Uint8Array
): Uint8Array {
    requireHmacKey(authKey)
    return hmac(
        sha256,
        authKey,
        concat(
            PUT_LABEL,
            new TextEncoder().encode(addressString),
            nonce,
            bodyDigest
        )
    )
}

/**
 * Timing-safe tag verification. `@noble/hashes` gives no comparator of its
 * own, and `a === b` / a manual short-circuiting loop over `Uint8Array`
 * leaks the length of the matching prefix through timing — exactly the
 * side channel an HMAC verifier exists to avoid.
 */
export function verifyGrantPutTag(
    authKey: Uint8Array,
    addressString: string,
    nonce: Uint8Array,
    bodyDigest: Uint8Array,
    tag: Uint8Array
): boolean {
    const expected = computeGrantPutTag(authKey, addressString, nonce, bodyDigest)
    if (expected.byteLength !== tag.byteLength) return false
    let diff = 0
    for (let i = 0; i < expected.byteLength; i++) {
        diff |= expected[i] ^ tag[i]
    }
    return diff === 0
}
