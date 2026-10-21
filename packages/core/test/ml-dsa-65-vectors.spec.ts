/**
 * The ML-DSA-65 known-answer vectors published at
 * spec/vectors/ml-dsa-65.json, which OpenSSL alone produced, checked against
 * this implementation. They are the interop contract for other
 * implementations, so a mismatch here means the vectors or the code is wrong, never that the vectors should be
 * regenerated to match.
 */
import { readFileSync } from "node:fs"
import { sha256 } from "@noble/hashes/sha2.js"
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"
import { describe, expect, it } from "vitest"
import {
    encodeAkpMlDsa65Key,
    thumbprintAkpMlDsa65,
} from "../src/cose/key"
import { parseSignatureInput } from "../src/http-sig/structured-fields"
import { signRequest } from "../src/http-sig/sign"
import {
    buildSignatureBase,
    verifyRequestSignature,
} from "../src/http-sig/verify"

const vectors = JSON.parse(
    readFileSync(
        new URL("../../../spec/vectors/ml-dsa-65.json", import.meta.url),
        "utf8"
    )
)

function hex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function fromHex(s: string): Uint8Array {
    const bytes = new Uint8Array(s.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

function b64url(bytes: Uint8Array): string {
    let s = ""
    for (const byte of bytes) s += String.fromCharCode(byte)
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const key = vectors.key
const request = vectors.request
const pub = fromHex(key.pub)
const body = fromHex(request.body_hex)

interface InvalidVector {
    name: string
    why: string
    signature_b64: string
    alg?: string
    signature_input?: string
}

function deterministic() {
    return vectors.valid.find(
        (v: { name: string }) => v.name === "deterministic"
    )
}

function verifyVector(signatureB64: string, signatureInput: string) {
    return verifyRequestSignature({
        request: new Request(request.url, {
            method: request.method,
            headers: {
                "content-digest": request.content_digest,
                "signature-input": signatureInput,
                signature: `${request.label}=:${signatureB64}:`,
            },
            body,
        }),
        body,
        publicKey: { kty: "AKP", alg: "ML-DSA-65", pub },
        nowSeconds: request.created,
    })
}

describe("ML-DSA-65 vectors", () => {
    it("derives the published public key from the published seed", () => {
        expect(vectors.context).toBe("")
        const { publicKey } = ml_dsa65.keygen(fromHex(key.seed))
        expect(hex(publicKey)).toBe(key.pub)
    })

    it("encodes the published COSE_Key and thumbprint input byte-for-byte", () => {
        expect(hex(encodeAkpMlDsa65Key({ pub }))).toBe(key.cose_key)
        expect(key.thumbprint_input).toBe(key.cose_key)
    })

    it("hashes the thumbprint input to the published thumbprint, hex and base64url", () => {
        const digest = sha256(fromHex(key.thumbprint_input))
        expect(hex(digest)).toBe(key.thumbprint_hex)
        expect(b64url(digest)).toBe(key.thumbprint_b64url)
        expect(hex(thumbprintAkpMlDsa65({ pub }))).toBe(key.thumbprint_hex)
        expect(request.keyid).toBe(key.thumbprint_b64url)
    })

    it("builds the published signature base from the published request", () => {
        const parts = signRequest({
            method: request.method,
            url: request.url,
            nonce: request.nonce,
            keyid: request.keyid,
            created: request.created,
            body,
            key: {
                alg: "ml-dsa-65",
                seed: fromHex(key.seed),
                deterministic: true,
            },
        })
        expect(parts.base).toBe(request.signature_base)
        expect(parts.headers["signature-input"]).toBe(request.signature_input)
        expect(parts.headers["content-digest"]).toBe(request.content_digest)
    })

    it("verifies every published valid signature with an empty context", () => {
        expect(vectors.valid.length).toBeGreaterThan(0)
        for (const vector of vectors.valid) {
            expect(
                ml_dsa65.verify(
                    fromHex(vector.signature_hex),
                    new TextEncoder().encode(request.signature_base),
                    pub,
                    { context: new Uint8Array(0) }
                )
            ).toBe(true)
            expect(
                verifyVector(vector.signature_b64, request.signature_input)
            ).toMatchObject({ valid: true, keyid: request.keyid })
        }
    })

    it("refuses every published invalid signature, for the reason the vector names", () => {
        const invalid: InvalidVector[] = vectors.invalid
        expect(invalid.map((v) => v.name).sort()).toEqual([
            "alg-relabelled",
            "bit-flipped",
            "context-pmr",
        ])
        for (const vector of invalid) {
            const outcome = verifyVector(
                vector.signature_b64,
                vector.signature_input ?? request.signature_input
            )
            expect(outcome, vector.name).toEqual({
                valid: false,
                reason:
                    vector.name === "alg-relabelled"
                        ? "unexpected alg"
                        : "signature verification failed",
            })
        }

        const validSig = fromHex(deterministic().signature_hex)
        const baseBytes = new TextEncoder().encode(request.signature_base)
        const byName = (name: string) =>
            invalid.find((v) => v.name === name) as InvalidVector & {
                signature_hex: string
                signature_base?: string
            }

        // context-pmr is a real signature under the context "pmr".
        expect(
            ml_dsa65.verify(fromHex(byName("context-pmr").signature_hex), baseBytes, pub, {
                context: new TextEncoder().encode("pmr"),
            })
        ).toBe(true)

        // bit-flipped differs from the valid signature in exactly one bit.
        const flipped = fromHex(byName("bit-flipped").signature_hex)
        let differing = 0
        flipped.forEach((byte, i) => {
            let diff = byte ^ validSig[i]
            while (diff) {
                differing += diff & 1
                diff >>= 1
            }
        })
        expect(flipped.length).toBe(validSig.length)
        expect(differing).toBe(1)

        // alg-relabelled carries the valid signature on the relabelled base,
        // over which it does not verify.
        const relabelled = byName("alg-relabelled")
        expect(relabelled.signature_hex).toBe(hex(validSig))
        const relabelledRequest = new Request(request.url, {
            method: request.method,
            headers: {
                "content-digest": request.content_digest,
                "signature-input": relabelled.signature_input!,
            },
            body,
        })
        const relabelledBase = buildSignatureBase(
            relabelledRequest,
            parseSignatureInput(relabelled.signature_input!).get(request.label)!
        )
        expect(relabelledBase).toBe(relabelled.signature_base)
        expect(
            ml_dsa65.verify(
                validSig,
                new TextEncoder().encode(relabelledBase),
                pub,
                { context: new Uint8Array(0) }
            )
        ).toBe(false)
    })

    it("signRequest with deterministic: true reproduces the published valid signature", () => {
        const parts = signRequest({
            method: request.method,
            url: request.url,
            nonce: request.nonce,
            keyid: request.keyid,
            created: request.created,
            body,
            key: {
                alg: "ml-dsa-65",
                seed: fromHex(key.seed),
                deterministic: true,
            },
        })
        expect(parts.headers.signature).toBe(
            `${request.label}=:${deterministic().signature_b64}:`
        )
    })
})
