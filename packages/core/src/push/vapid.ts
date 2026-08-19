import { p256 } from "@noble/curves/nist.js"
import { binaryToBase64URL } from "../util.js"

/**
 * VAPID (RFC 8292) delivery authentication for Web Push (RFC 8030).
 *
 * ES256 over `@noble/curves`, matching this package's existing choice of
 * noble over WebCrypto elsewhere (`message-id.ts`, `grant.ts`). Two
 * behaviors worth stating explicitly, since both are easy to get backwards
 * and neither fails loudly if wrong — a bad signature is rejected by the
 * verifier as `badSignature`, indistinguishable from an unrelated bug:
 *
 * - `p256.sign` already pre-hashes its input with SHA-256 by DEFAULT
 *   (`prehash: true` is the library default, not an opt-in). JWS ES256
 *   signs `SHA-256(signing input)`, so signing with the library's default
 *   options is correct as-is — do NOT hash the input yourself before
 *   calling `sign`, which would double-hash and produce a signature no
 *   compliant verifier accepts.
 * - `p256.sign`'s default output format is `'compact'`: a raw 64-byte
 *   `r‖s`. That is exactly what JWS wants. Do not request `'der'`.
 */

const MAX_EXPIRY_SECONDS = 86400

export interface SignVapidJwtOptions {
    /** Scheme + host of the push subscription's endpoint, no path, no trailing slash. */
    audience: string
    /** A `mailto:` or `https:` contact per RFC 8292 §2.1. Not checked by every push service, but some require it. */
    subject: string
    /** MUST be <= 86400 (24h) — push services enforce this ceiling. */
    expirySeconds: number
    /** 32-byte P-256 scalar. */
    privateKey: Uint8Array
    nowSeconds: number
}

function base64UrlJson(value: unknown): string {
    return binaryToBase64URL(new TextEncoder().encode(JSON.stringify(value)))
}

/** Produces the `t=<jwt>` half of the VAPID `Authorization` header. */
export function signVapidJWT(opts: SignVapidJwtOptions): string {
    if (opts.expirySeconds > MAX_EXPIRY_SECONDS) {
        throw new Error(
            `VAPID JWT expiry must be <= ${MAX_EXPIRY_SECONDS}s (24h); got ${opts.expirySeconds}`
        )
    }
    const header = base64UrlJson({ typ: "JWT", alg: "ES256" })
    const payload = base64UrlJson({
        aud: opts.audience,
        exp: opts.nowSeconds + opts.expirySeconds,
        sub: opts.subject,
    })
    const signingInput = new TextEncoder().encode(`${header}.${payload}`)
    const signature = p256.sign(signingInput, opts.privateKey)
    return `${header}.${payload}.${binaryToBase64URL(signature)}`
}

/**
 * The full VAPID `Authorization` header. Carries both `t=` (the JWT) and
 * `k=` (the raw public key) — germ-service parses only `t=` and verifies
 * against the key it already has bound to the subscription, but a browser
 * push service requires `k=` to look the key up at all, per RFC 8292.
 */
export function vapidAuthorizationHeader(
    jwt: string,
    publicKey: string
): string {
    return `vapid t=${jwt}, k=${publicKey}`
}
