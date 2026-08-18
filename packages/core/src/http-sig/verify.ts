import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import {
    parseSignature,
    parseSignatureInput,
    type InnerList,
} from "./structured-fields.js"

/**
 * RFC 9421 HTTP Message Signatures — verification.
 *
 * `spec/wire-api.md`, "Request authentication". The standard supplies the
 * parts that are nobody's business to invent: the signature base
 * canonicalization is specified with test vectors, so "exactly what is
 * signed" — the likeliest source of silent interop failure between two
 * independent implementations — is not this project's to define.
 *
 * What this file adds on top of the RFC is the profile's refusals.
 */

/** Components every conforming request must cover. */
export const REQUIRED_COMPONENTS = ["@method", "@authority", "@path"] as const

/** Additionally required whenever the request carries a body. */
export const BODY_COMPONENT = "content-digest"

export const DEFAULT_LABEL = "pmr"

export type VerifyOutcome =
    | {
          valid: true
          /** The server-issued challenge, for the caller to redeem. */
          nonce: string
          /**
           * RFC 9679 thumbprint the signer claims. **Diagnostic only** — a
           * thumbprint cannot be verified against, and the signature was
           * checked against the resolved key regardless. Useful to make a
           * rotation legible rather than an unexplained failure.
           */
          keyid: string
          created?: number
      }
    /**
     * One shape for every failure. `reason` is for server logs and MUST NOT
     * be echoed to a peer: which check failed is exactly the oracle an
     * attacker wants.
     */
    | { valid: false; reason: string }

export interface VerifyInput {
    request: Request
    /**
     * The body as already read by the caller, or `null` for a bodyless
     * request. Passed in rather than read here because the caller owns the
     * size cap — a verifier that reads an unbounded body has created a
     * denial-of-service surface before it has authenticated anything.
     */
    body: Uint8Array | null
    /**
     * The Ed25519 public key, **resolved by the caller** from the identity
     * the challenge was bound to. Never taken from the message.
     */
    publicKey: Uint8Array
    nowSeconds: number
    label?: string
}

export function verifyRequestSignature(input: VerifyInput): VerifyOutcome {
    const label = input.label ?? DEFAULT_LABEL
    const { request } = input

    const inputHeader = request.headers.get("signature-input")
    const sigHeader = request.headers.get("signature")
    if (inputHeader === null || sigHeader === null) {
        return { valid: false, reason: "missing signature headers" }
    }

    let entry: InnerList | undefined
    let signature: Uint8Array | undefined
    try {
        entry = parseSignatureInput(inputHeader).get(label)
        signature = parseSignature(sigHeader).get(label)
    } catch (e) {
        return { valid: false, reason: `malformed signature headers: ${e}` }
    }
    if (entry === undefined || signature === undefined) {
        return { valid: false, reason: `no signature labelled ${label}` }
    }

    // --- Profile refusals, before any crypto. ---

    const covered = new Set(entry.items)
    if (covered.size !== entry.items.length) {
        return { valid: false, reason: "duplicate covered component" }
    }
    for (const required of REQUIRED_COMPONENTS) {
        if (!covered.has(required)) {
            return { valid: false, reason: `missing component ${required}` }
        }
    }

    const hasBody = input.body !== null && input.body.byteLength > 0
    if (hasBody && !covered.has(BODY_COMPONENT)) {
        // RFC 9421's base covers no body bytes at all. Without this, a
        // signature authenticates WHICH request was made but not WHAT it
        // carried, and an attacker could swap the body wholesale while the
        // signature still verified.
        return { valid: false, reason: "bodied request must cover content-digest" }
    }

    // Same reasoning as the body check, for the other thing `@path` alone
    // does not cover: a query string. Without this, a signature
    // authenticates the endpoint but not which page/cursor/filter was
    // asked for, so a captured signature could be replayed against any
    // query the base URL accepts — on a cursor-paged surface, that both
    // extends what a captor can page through and lets a query get
    // silently rewritten without invalidating the signature.
    const hasQuery = new URL(request.url).search !== ""
    if (hasQuery && !covered.has("@query")) {
        return { valid: false, reason: "request with a query string must cover @query" }
    }

    // The algorithm is pinned to what the resolved key implies. `alg` in
    // the message is checked for conformance but never consulted to decide
    // how to verify — trusting it would let a signer nominate a weaker
    // algorithm, or one whose verification we would perform against the
    // wrong key type.
    // The profile says a conforming request MUST carry both, so absence is
    // a refusal rather than a default. `alg` is still never *consulted* to
    // choose the algorithm — it is checked for conformance and discarded;
    // the algorithm is pinned to what the resolved key implies.
    const alg = entry.params.get("alg")
    if (alg !== "ed25519") {
        return { valid: false, reason: "unexpected alg" }
    }
    if (typeof entry.params.get("keyid") !== "string") {
        return { valid: false, reason: "missing keyid" }
    }

    const nonce = entry.params.get("nonce")
    if (typeof nonce !== "string" || nonce.length === 0) {
        return { valid: false, reason: "missing nonce" }
    }

    // Freshness rests on the challenge, not the client's clock, so
    // `created` is not range-checked. An explicit `expires` in the past is
    // still honoured: the signer asked for it.
    const expires = entry.params.get("expires")
    if (typeof expires === "number" && input.nowSeconds > expires) {
        return { valid: false, reason: "signature expired" }
    }

    // --- Content-Digest must MATCH, not merely be covered. ---
    if (covered.has(BODY_COMPONENT)) {
        const digestHeader = request.headers.get("content-digest")
        if (digestHeader === null) {
            return { valid: false, reason: "content-digest covered but absent" }
        }
        if (!contentDigestMatches(digestHeader, input.body ?? new Uint8Array(0))) {
            return { valid: false, reason: "content-digest mismatch" }
        }
    }

    // --- Build the base and verify. ---
    let base: string
    try {
        base = buildSignatureBase(request, entry)
    } catch (e) {
        return { valid: false, reason: `cannot build signature base: ${e}` }
    }

    let ok = false
    try {
        ok = ed25519.verify(
            signature,
            new TextEncoder().encode(base),
            input.publicKey,
            { zip215: false }
        )
    } catch {
        ok = false
    }
    if (!ok) return { valid: false, reason: "signature verification failed" }

    const keyid = entry.params.get("keyid") as string
    const created = entry.params.get("created")
    return {
        valid: true,
        nonce,
        keyid,
        created: typeof created === "number" ? created : undefined,
    }
}

/**
 * RFC 9421 §2.5. One line per covered component, then `@signature-params`
 * last, with no trailing newline.
 */
export function buildSignatureBase(request: Request, entry: InnerList): string {
    const url = new URL(request.url)
    const lines: string[] = []

    for (const component of entry.items) {
        lines.push(`"${component}": ${componentValue(request, url, component)}`)
    }

    // Taken verbatim from the received header rather than re-serialized —
    // see `InnerList.raw`.
    lines.push(`"@signature-params": ${entry.raw}`)
    return lines.join("\n")
}

function componentValue(request: Request, url: URL, component: string): string {
    switch (component) {
        case "@method":
            return request.method.toUpperCase()
        case "@authority":
            // Host, lowercased, default port omitted — as the RFC requires,
            // so that an equivalent request cannot produce a different base.
            return url.host.toLowerCase()
        case "@path":
            return url.pathname
        case "@query":
            return url.search === "" ? "?" : url.search
        case "@target-uri":
            return url.toString()
        default: {
            if (component.startsWith("@")) {
                // An unsupported derived component must fail loudly. Signing
                // something we cannot reconstruct means we would verify a
                // different base than the signer built.
                throw new Error(`unsupported derived component ${component}`)
            }
            if (component !== component.toLowerCase()) {
                throw new Error("component names must be lowercase")
            }
            const value = request.headers.get(component)
            if (value === null) {
                throw new Error(`covered header absent: ${component}`)
            }
            return value.trim()
        }
    }
}

/**
 * RFC 9530 `Content-Digest`, restricted to `sha-256`.
 *
 * Accepts a dictionary that may carry several algorithms: every `sha-256`
 * entry must match, and at least one must be present. An unknown algorithm
 * alone is a failure rather than a pass — otherwise a sender could offer
 * only `sha-512`, have nothing checked, and swap the body freely.
 */
export function contentDigestMatches(header: string, body: Uint8Array): boolean {
    const expected = sha256(body)
    let sawSha256 = false

    for (const part of splitTopLevel(header)) {
        const eq = part.indexOf("=")
        if (eq < 0) return false
        const alg = part.slice(0, eq).trim().toLowerCase()
        const raw = part.slice(eq + 1).trim()
        if (alg !== "sha-256") continue
        if (!raw.startsWith(":") || !raw.endsWith(":") || raw.length < 2) {
            return false
        }
        const b64 = raw.slice(1, -1)
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return false
        let bin: string
        try {
            bin = atob(b64)
        } catch {
            return false
        }
        if (bin.length !== expected.length) return false
        let diff = 0
        for (let i = 0; i < expected.length; i++) {
            diff |= bin.charCodeAt(i) ^ expected[i]
        }
        if (diff !== 0) return false
        sawSha256 = true
    }
    return sawSha256
}

/** Split a dictionary on commas that are not inside `:…:` byte sequences. */
function splitTopLevel(s: string): string[] {
    const out: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ":") depth = depth === 0 ? 1 : 0
        else if (s[i] === "," && depth === 0) {
            out.push(s.slice(start, i))
            start = i + 1
        }
    }
    out.push(s.slice(start))
    return out.filter((p) => p.trim().length > 0)
}
