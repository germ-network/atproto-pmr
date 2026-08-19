import { gcm } from "@noble/ciphers/aes.js"

/**
 * Web Push payload sealing (`spec/wire-api.md`, "Push delivery — Web Push
 * (optional)"): `key_id ‖ nonce ‖ AEAD ciphertext`, AES-256-GCM.
 *
 * Uses `@noble/ciphers` rather than WebCrypto, matching `message-id.ts` and
 * `grant.ts`'s existing choice to keep this package free of any platform's
 * crypto global — this module's nonce is caller-supplied for the same
 * reason those files avoid `crypto.subtle`: synchronous, and testable
 * without an async boundary.
 */

export class PushPayloadTooLargeError extends Error {
    constructor() {
        super("Sealed push payload exceeds the push service's size ceiling")
        this.name = "PushPayloadTooLargeError"
    }
}

const KEY_ID_BYTES = 1
const NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
/** `key_id` + `nonce` + GCM tag — the fixed overhead over the plaintext. */
export const SEAL_OVERHEAD_BYTES = KEY_ID_BYTES + NONCE_BYTES + GCM_TAG_BYTES

export interface SealPushPayloadOptions {
    contentKey: Uint8Array
    keyId: number
    /**
     * MUST be a fresh, random 12-byte value per call — never a counter. A
     * serverless deliverer holds no state between invocations, so a
     * counter would silently repeat under any concurrency or restart, and
     * nonce reuse under GCM is a full confidentiality break, not a
     * degraded one. `spec/wire-api.md` states this as a MUST for exactly
     * this reason.
     */
    randomBytes: (n: number) => Uint8Array
    /** The push service's payload ceiling, in bytes, including this seal's overhead. */
    maxSealedBytes: number
}

/**
 * Seals `plaintext` for Web Push delivery. Throws `PushPayloadTooLargeError`
 * before doing any encryption work if the result would exceed
 * `maxSealedBytes` — the ticket's "413 must be caught at seal time, not
 * discovered at POST time" requirement, since the deliverer knows the
 * plaintext size and the push service does not tell it the limit per
 * request.
 *
 * `aad` is authenticated but never transmitted — pass the relay's own host
 * here rather than putting it in `plaintext`. The device already resolves
 * the host from `keyId` before it opens the seal, so retransmitting it
 * would be redundant; binding it as AAD instead catches a `keyId`/host
 * mismatch as a decryption failure rather than silently trusting it.
 */
export function sealPushPayload(
    plaintext: Uint8Array,
    opts: SealPushPayloadOptions & { aad?: Uint8Array }
): Uint8Array {
    if (opts.contentKey.byteLength !== 32) {
        throw new Error("contentKey must be 32 bytes")
    }
    if (!Number.isInteger(opts.keyId) || opts.keyId < 0 || opts.keyId > 255) {
        throw new Error("keyId must be an integer in 0..255")
    }
    if (plaintext.byteLength + SEAL_OVERHEAD_BYTES > opts.maxSealedBytes) {
        throw new PushPayloadTooLargeError()
    }

    const nonce = opts.randomBytes(NONCE_BYTES)
    const sealed = gcm(opts.contentKey, nonce, opts.aad).encrypt(plaintext)

    const out = new Uint8Array(KEY_ID_BYTES + NONCE_BYTES + sealed.byteLength)
    out[0] = opts.keyId
    out.set(nonce, KEY_ID_BYTES)
    out.set(sealed, KEY_ID_BYTES + NONCE_BYTES)
    return out
}
