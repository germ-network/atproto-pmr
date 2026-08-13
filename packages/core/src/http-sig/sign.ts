import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { parseSignatureInput } from "./structured-fields.js"
import { toResponseBody } from "../util.js"
import { buildSignatureBase, DEFAULT_LABEL } from "./verify.js"

/**
 * The client half of RFC 9421, for tests and for client implementers.
 *
 * A server never signs a request, so this is not on any hot path. It is
 * exported because a specification whose only signer is the test suite of
 * one implementation tends to grow accidental dependencies on that
 * implementation's quirks — and because a client author needs something to
 * check their own signer against.
 */

export interface SignOptions {
    method: string
    url: string
    /** Server-issued challenge, carried in the `nonce` parameter. */
    nonce: string
    /** RFC 9679 thumbprint of the signing key. */
    keyid: string
    secretKey: Uint8Array
    body?: Uint8Array
    created?: number
    label?: string
    /** Override the covered components. Tests use this to build bad requests. */
    components?: string[]
}

export interface SignedRequestParts {
    headers: Record<string, string>
    base: string
}

export function signRequest(opts: SignOptions): SignedRequestParts {
    const label = opts.label ?? DEFAULT_LABEL
    const hasBody = opts.body !== undefined && opts.body.byteLength > 0

    const components =
        opts.components ??
        (hasBody
            ? ["@method", "@authority", "@path", "content-digest"]
            : ["@method", "@authority", "@path"])

    const headers: Record<string, string> = {}
    if (hasBody) {
        headers["content-digest"] = `sha-256=:${b64(sha256(opts.body!))}:`
    }

    const params = [
        `nonce="${opts.nonce}"`,
        ...(opts.created !== undefined ? [`created=${opts.created}`] : []),
        `keyid="${opts.keyid}"`,
        `alg="ed25519"`,
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

    const signature = ed25519.sign(
        new TextEncoder().encode(base),
        opts.secretKey
    )
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
