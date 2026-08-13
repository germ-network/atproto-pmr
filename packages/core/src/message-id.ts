import { sha256 } from "@noble/hashes/sha2.js"

/**
 * Content-addressed message identity and local mailbox keys.
 *
 * Both use `@noble/hashes` rather than WebCrypto, deliberately: it keeps
 * this package free of any platform's crypto global, and it lets these be
 * synchronous, which matters because they sit on the pair-put hot path.
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

/**
 * A pair mailbox's local key.
 *
 * Hashing the counterpart DID keeps plaintext identifiers out of storage
 * keys, access logs, and monitoring. This derivation is **unilateral**: it
 * crosses no wire, needs no agreement with any other implementation, and
 * therefore carries none of the silent-mail-loss risk a shared derivation
 * would. An implementation is free to use a different one.
 */
export function deriveMailboxKey(counterpartDID: string): string {
    return hex(sha256(new TextEncoder().encode(counterpartDID)))
}
