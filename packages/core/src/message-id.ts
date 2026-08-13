import { sha256 } from "@noble/hashes/sha2.js"

/**
 * Content-addressed message identity.
 *
 * Uses `@noble/hashes` rather than WebCrypto, deliberately: it keeps this
 * package free of any platform's crypto global, and it lets this be
 * synchronous, which matters because it sits on the pair-put hot path.
 */

/**
 * `TypedDigest` wire format: one algorithm-identifier byte followed by the
 * digest bytes — algorithm-prefixed and self-describing, not multihash and
 * not a CID (`spec/wire-api.md`, "Content addressing and idempotency").
 *
 * SHA-256 is the only algorithm currently assigned. The identifier
 * assignments are listed as not-yet-specified; this value matches the
 * format's existing definition.
 */
const DIGEST_ALG_SHA256 = 1

function hex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * The message identifier, derived over the SEALED PAYLOAD — never the
 * signature envelope.
 *
 * Ed25519 signatures are malleable, so content-addressing the envelope
 * would let a malleated copy slip past dedup, which is replay by another
 * door (`spec/wire-api.md`, "Malleability"). Addressing the stable message
 * identity instead is one of the two requirements there; rejecting
 * non-canonical signatures is the other, and either alone is insufficient.
 */
export function deriveMessageId(payload: Uint8Array): string {
    const digest = sha256(payload)
    const out = new Uint8Array(1 + digest.length)
    out[0] = DIGEST_ALG_SHA256
    out.set(digest, 1)
    return hex(out)
}
