import { ed25519 } from "@noble/curves/ed25519.js"
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { parseSignatureInput } from "./structured-fields.js"
import { toResponseBody } from "../util.js"
import {
    buildSignatureBase,
    DEFAULT_LABEL,
    type RequestSignatureAlg,
} from "./verify.js"

/**
 * The client half of RFC 9421, for tests and for client implementers.
 *
 * A server never signs a request, so this is not on any hot path. It is
 * exported because a specification whose only signer is the test suite of
 * one implementation tends to grow accidental dependencies on that
 * implementation's quirks — and because a client author needs something to
 * check their own signer against.
 */

export type SignOptions = SignOptionsBase &
    (
        | {
              /** A raw Ed25519 secret key. */
              secretKey: Uint8Array
              key?: never
          }
        | { key: SigningKey; secretKey?: never }
    )

interface SignOptionsBase {
    method: string
    url: string
    /** Server-issued challenge, carried in the `nonce` parameter. */
    nonce: string
    /** RFC 9679 thumbprint of the signing key. */
    keyid: string
    body?: Uint8Array
    created?: number
    label?: string
    /** Override the covered components. Tests use this to build bad requests. */
    components?: string[]
}

/**
 * An ML-DSA-65 key is its 32-byte seed, the only private form RFC 9964 §4
 * allows. Signing is hedged; `deterministic` (all-zero per-signature
 * randomness) exists only so published vectors can be regenerated and
 * reproduced by another implementation. The context is always empty
 * (RFC 9964 §5), so there is deliberately no way to sign under another.
 */
export type SigningKey =
    | { alg: Extract<RequestSignatureAlg, "ed25519">; secretKey: Uint8Array }
    | {
          alg: Extract<RequestSignatureAlg, "ml-dsa-65">
          seed: Uint8Array
          deterministic?: true
      }

export interface SignedRequestParts {
    headers: Record<string, string>
    base: string
}

export function signRequest(opts: SignOptions): SignedRequestParts {
    let key: SigningKey
    if (opts.key !== undefined && opts.secretKey === undefined) {
        key = opts.key
    } else if (opts.secretKey !== undefined && opts.key === undefined) {
        key = { alg: "ed25519", secretKey: opts.secretKey }
    } else {
        throw new Error("signRequest: pass exactly one of key and secretKey")
    }
    if (key.alg === "ml-dsa-65" && key.seed.byteLength !== 32) {
        throw new Error("signRequest: an ML-DSA-65 key is its 32-byte seed")
    }
    const label = opts.label ?? DEFAULT_LABEL
    const hasBody = opts.body !== undefined && opts.body.byteLength > 0
    const hasQuery = new URL(opts.url).search !== ""

    const components =
        opts.components ??
        [
            "@method",
            "@authority",
            "@path",
            ...(hasQuery ? ["@query"] : []),
            ...(hasBody ? ["content-digest"] : []),
        ]

    const headers: Record<string, string> = {}
    if (hasBody) {
        headers["content-digest"] = `sha-256=:${b64(sha256(opts.body!))}:`
    }

    const params = [
        `nonce="${opts.nonce}"`,
        ...(opts.created !== undefined ? [`created=${opts.created}`] : []),
        `keyid="${opts.keyid}"`,
        `alg="${key.alg}"`,
    ].join(";")
    const inner = `(${components.map((c) => `"${c}"`).join(" ")})`
    const signatureInput = `${label}=${inner};${params}`

    // Build the base through the same code the verifier uses, from a real
    // Request — so a signer bug cannot cancel out a verifier bug and leave
    // the tests green against a base neither the RFC nor a peer produces.
    const request = new Request(opts.url, {
        method: opts.method,
        headers: { ...headers, "signature-input": signatureInput },
        ...(hasBody ? { body: toResponseBody(opts.body!) } : {}),
    })
    const entry = parseSignatureInput(signatureInput).get(label)!
    const base = buildSignatureBase(request, entry)

    const message = new TextEncoder().encode(base)
    const signature =
        key.alg === "ml-dsa-65"
            ? ml_dsa65.sign(message, ml_dsa65.keygen(key.seed).secretKey, {
                  context: new Uint8Array(0),
                  extraEntropy: key.deterministic ? false : undefined,
              })
            : ed25519.sign(message, key.secretKey)
    return {
        headers: {
            ...headers,
            "signature-input": signatureInput,
            signature: `${label}=:${b64(signature)}:`,
        },
        base,
    }
}

function b64(bytes: Uint8Array): string {
    let s = ""
    for (const byte of bytes) s += String.fromCharCode(byte)
    return btoa(s)
}
