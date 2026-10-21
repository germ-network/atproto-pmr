/**
 * RFC 9421 verification dispatched by the resolved key's type. The
 * algorithm comes from the key the caller resolved, never from `alg`; `alg`
 * is only checked to be the one value that key type requires, so a
 * signature cannot cross from one algorithm to the other in either
 * direction.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256, sha512 } from "@noble/hashes/sha2.js"
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"
import { describe, expect, it } from "vitest"
import {
    encodeAkpMlDsa65Key,
    type CosePublicKey,
} from "../src/cose/key"
import { signRequest } from "../src/http-sig/sign"
import { parseSignatureInput } from "../src/http-sig/structured-fields"
import {
    buildSignatureBase,
    requestSignatureAlg,
    verifyRequestSignature,
} from "../src/http-sig/verify"

const T0 = 1_760_000_000
const URL_ = "https://relay.example/pmr/v1/registrations"
const BODY = new TextEncoder().encode("body")

const mlKey = ml_dsa65.keygen(new Uint8Array(32).fill(7))
const otherMlKey = ml_dsa65.keygen(new Uint8Array(32).fill(8))
const edSecret = ed25519.utils.randomSecretKey()
const edPublic = ed25519.getPublicKey(edSecret)

const mlCose = (pub: Uint8Array): CosePublicKey => ({
    kty: "AKP",
    alg: "ML-DSA-65",
    pub,
})
const edCose = (x: Uint8Array): CosePublicKey => ({
    kty: "OKP",
    crv: "Ed25519",
    x,
})

function b64(bytes: Uint8Array): string {
    let s = ""
    for (const byte of bytes) s += String.fromCharCode(byte)
    return btoa(s)
}

/**
 * A signed request built by hand, so a test can sign under a context, a
 * prehash or a mislabelled `alg` that signRequest refuses to produce.
 */
function signed(opts: {
    alg: string
    sign: (message: Uint8Array) => Uint8Array
    body?: Uint8Array
    omitAlg?: boolean
}) {
    const body = opts.body ?? BODY
    const digest = `sha-256=:${b64(sha256(body))}:`
    const params = [
        `nonce="n1"`,
        `created=${T0}`,
        `keyid="k"`,
        ...(opts.omitAlg ? [] : [`alg="${opts.alg}"`]),
    ].join(";")
    const signatureInput = `pmr=("@method" "@authority" "@path" "content-digest");${params}`
    const request = new Request(URL_, {
        method: "POST",
        headers: { "content-digest": digest, "signature-input": signatureInput },
        body,
    })
    const base = buildSignatureBase(
        request,
        parseSignatureInput(signatureInput).get("pmr")!
    )
    const signature = opts.sign(new TextEncoder().encode(base))
    return {
        headers: {
            "content-digest": digest,
            "signature-input": signatureInput,
            signature: `pmr=:${b64(signature)}:`,
        },
        body,
    }
}

const signMl = (secretKey: Uint8Array = mlKey.secretKey) => (m: Uint8Array) =>
    ml_dsa65.sign(m, secretKey)

function verify(
    request: ReturnType<typeof signed>,
    publicKey: Uint8Array | CosePublicKey,
    body: Uint8Array | null = request.body
) {
    return verifyRequestSignature({
        request: new Request(URL_, {
            method: "POST",
            headers: request.headers,
            body: request.body,
        }),
        body,
        publicKey,
        nowSeconds: T0,
    })
}

describe("requestSignatureAlg", () => {
    it("is ed25519 for raw bytes and for an OKP/Ed25519 key", () => {
        expect(requestSignatureAlg(edPublic)).toBe("ed25519")
        expect(requestSignatureAlg(edCose(edPublic))).toBe("ed25519")
    })

    it("is ml-dsa-65 for an AKP/ML-DSA-65 key", () => {
        expect(requestSignatureAlg(mlCose(mlKey.publicKey))).toBe("ml-dsa-65")
    })

    it("throws on bare bytes that are not 32 long rather than calling them Ed25519", () => {
        expect(() => requestSignatureAlg(mlKey.publicKey)).toThrow()
        expect(() => requestSignatureAlg(new Uint8Array(31))).toThrow()
        expect(() => requestSignatureAlg(new Uint8Array(0))).toThrow()
    })
})

describe("verifyRequestSignature with an ML-DSA-65 key", () => {
    const key = mlCose(mlKey.publicKey)

    it("accepts a request signed by the key with an empty context", () => {
        const request = signed({ alg: "ml-dsa-65", sign: signMl() })
        expect(verify(request, key)).toMatchObject({
            valid: true,
            nonce: "n1",
            keyid: "k",
        })
    })

    it("refuses a signature made with a non-empty context (built with ml_dsa65.sign directly)", () => {
        const request = signed({
            alg: "ml-dsa-65",
            sign: (m) =>
                ml_dsa65.sign(m, mlKey.secretKey, {
                    context: new TextEncoder().encode("pmr"),
                }),
        })
        expect(verify(request, key)).toEqual({
            valid: false,
            reason: "signature verification failed",
        })
    })

    it("refuses a HashML-DSA (prehash) signature over the base", () => {
        const request = signed({
            alg: "ml-dsa-65",
            sign: (m) => ml_dsa65.prehash(sha512).sign(m, mlKey.secretKey),
        })
        expect(verify(request, key)).toEqual({
            valid: false,
            reason: "signature verification failed",
        })
    })

    it("refuses alg=\"ed25519\" on a request whose resolved key is ML-DSA-65", () => {
        const request = signed({ alg: "ed25519", sign: signMl() })
        expect(verify(request, key)).toEqual({
            valid: false,
            reason: "unexpected alg",
        })
    })

    it("refuses alg=\"ml-dsa-65\" on a request whose resolved key is Ed25519", () => {
        const request = signed({
            alg: "ml-dsa-65",
            sign: (m) => ed25519.sign(m, edSecret),
        })
        expect(verify(request, edPublic)).toEqual({
            valid: false,
            reason: "unexpected alg",
        })
        expect(verify(request, edCose(edPublic))).toEqual({
            valid: false,
            reason: "unexpected alg",
        })
    })

    it("refuses a signature by a different ML-DSA-65 key", () => {
        const request = signed({
            alg: "ml-dsa-65",
            sign: signMl(otherMlKey.secretKey),
        })
        expect(verify(request, key)).toEqual({
            valid: false,
            reason: "signature verification failed",
        })
    })

    it("refuses a body swapped under a covered content-digest", () => {
        const request = signed({ alg: "ml-dsa-65", sign: signMl() })
        expect(
            verify(request, key, new TextEncoder().encode("other"))
        ).toEqual({ valid: false, reason: "content-digest mismatch" })
    })

    it("refuses a truncated or oversized signature without throwing", () => {
        const good = signed({ alg: "ml-dsa-65", sign: signMl() })
        const raw = ml_dsa65.sign(new Uint8Array(1), mlKey.secretKey)
        for (const sig of [
            raw.slice(0, raw.length - 1),
            new Uint8Array([...raw, 0]),
            new Uint8Array(0),
        ]) {
            const request = {
                ...good,
                headers: { ...good.headers, signature: `pmr=:${b64(sig)}:` },
            }
            expect(verify(request, key)).toEqual({
                valid: false,
                reason: "signature verification failed",
            })
        }
    })

    it("refuses, without throwing, when the resolved pub is the wrong length", () => {
        const request = signed({ alg: "ml-dsa-65", sign: signMl() })
        for (const length of [0, 1951, 1953]) {
            expect(verify(request, mlCose(new Uint8Array(length)))).toEqual({
                valid: false,
                reason: "signature verification failed",
            })
        }
    })

    it("refuses a request with no alg", () => {
        const request = signed({
            alg: "ml-dsa-65",
            sign: signMl(),
            omitAlg: true,
        })
        expect(verify(request, key)).toEqual({
            valid: false,
            reason: "unexpected alg",
        })
    })

    it("refuses bare key bytes that are not 32 long as a malformed key, before any crypto", () => {
        const request = signed({ alg: "ml-dsa-65", sign: signMl() })
        for (const bare of [mlKey.publicKey, encodeAkpMlDsa65Key({ pub: mlKey.publicKey }), new Uint8Array(31)]) {
            expect(verify(request, bare)).toEqual({
                valid: false,
                reason: "malformed key",
            })
        }
    })

    it("keeps every existing profile refusal: missing nonce, missing keyid, uncovered content-digest", () => {
        const good = signed({ alg: "ml-dsa-65", sign: signMl() })
        const input = good.headers["signature-input"]
        const withInput = (value: string) => ({
            ...good,
            headers: { ...good.headers, "signature-input": value },
        })
        expect(
            verify(withInput(input.replace('nonce="n1";', "")), key)
        ).toEqual({ valid: false, reason: "missing nonce" })
        expect(
            verify(withInput(input.replace('keyid="k";', "")), key)
        ).toEqual({ valid: false, reason: "missing keyid" })
        expect(
            verify(withInput(input.replace(' "content-digest"', "")), key)
        ).toEqual({ valid: false, reason: "bodied request must cover content-digest" })
    })
})

describe("Ed25519 verification is unchanged", () => {
    it("accepts an Ed25519 request whether the key is passed as raw bytes or as an OKP CosePublicKey", () => {
        const parts = signRequest({
            method: "POST",
            url: URL_,
            nonce: "n1",
            keyid: "k",
            secretKey: edSecret,
            body: BODY,
            created: T0,
        })
        const request = { headers: parts.headers, body: BODY }
        for (const key of [edPublic, edCose(edPublic)]) {
            expect(verify(request as ReturnType<typeof signed>, key)).toMatchObject({
                valid: true,
            })
        }
    })

    it("a raw ML-DSA pub or an AKP COSE_Key blob passed as bare bytes never reaches ML-DSA verification", () => {
        const request = signed({ alg: "ml-dsa-65", sign: signMl() })
        for (const bare of [mlKey.publicKey, encodeAkpMlDsa65Key({ pub: mlKey.publicKey })]) {
            expect(verify(request, bare)).toEqual({
                valid: false,
                reason: "malformed key",
            })
        }
    })
})

describe("signRequest with an ML-DSA-65 key", () => {
    it.todo("emits alg=\"ml-dsa-65\" and a 3309-byte signature")
    it.todo("is hedged by default: two signatures of the same base differ and both verify")
    it.todo("is deterministic with deterministic: true")
    it.todo("refuses, at runtime, untyped options that set both secretKey and key, or neither")
})
