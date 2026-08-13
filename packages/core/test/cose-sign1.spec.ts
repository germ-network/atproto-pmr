/**
 * COSE_Sign1 for the pair-put payload. These tests pin the security
 * boundary described in cose/sign1.ts: the four-step verification order,
 * `kid` never participating in trust, recipient-DID binding, and
 * non-canonical-signature rejection (RFC 8032 §5.1.7).
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { decodeCoseArray, encodeCose } from "../src/cose/cbor"
import {
    PAIR_PUT_TYPE_VERSION,
    decodePairPutEnvelope,
    encodePairPutEnvelope,
    verifyPairPut,
} from "../src/cose/sign1"

const SENDER_DID = "did:plc:sender0000000000000000000"
const RECIPIENT_DID = "did:plc:recipient00000000000000000"

function keypair() {
    const secretKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(secretKey)
    return { secretKey, publicKey }
}

function makeEnvelope(
    overrides: Partial<{
        senderDID: string
        recipientDID: string
        nonce: Uint8Array
        payload: Uint8Array
        secretKey: Uint8Array
        kid: Uint8Array
    }> = {}
) {
    const { secretKey, publicKey } = keypair()
    const sk = overrides.secretKey ?? secretKey
    const bytes = encodePairPutEnvelope(
        {
            senderDID: overrides.senderDID ?? SENDER_DID,
            recipientDID: overrides.recipientDID ?? RECIPIENT_DID,
            kid: overrides.kid ?? new Uint8Array(32).fill(0xaa),
            nonce: overrides.nonce ?? new Uint8Array(16).fill(1),
            payload: overrides.payload ?? new TextEncoder().encode("sealed"),
        },
        (message) => ed25519.sign(message, sk)
    )
    return { bytes, publicKey, secretKey: sk }
}

describe("round trip: encode, decode, verify", () => {
    it("verifies against the signer's own key for the correct recipient", () => {
        const { bytes, publicKey } = makeEnvelope()
        const envelope = decodePairPutEnvelope(bytes)
        const outcome = verifyPairPut(envelope, publicKey, RECIPIENT_DID)
        expect(outcome.valid).toBe(true)
    })

    it("carries the sender DID, recipient DID, and payload through untouched", () => {
        const { bytes } = makeEnvelope({
            payload: new TextEncoder().encode("hello"),
        })
        const envelope = decodePairPutEnvelope(bytes)
        expect(envelope.payload.senderDID).toBe(SENDER_DID)
        expect(envelope.payload.recipientDID).toBe(RECIPIENT_DID)
        expect(new TextDecoder().decode(envelope.payload.payload)).toBe(
            "hello"
        )
    })
})

describe("step 3 — verifies against the resolved key, never a key from the message", () => {
    it("rejects when verified against a DIFFERENT key than the one that signed", () => {
        const { bytes } = makeEnvelope()
        const attacker = keypair()
        const envelope = decodePairPutEnvelope(bytes)
        const outcome = verifyPairPut(envelope, attacker.publicKey, RECIPIENT_DID)
        expect(outcome.valid).toBe(false)
    })

    it("kid is never consulted by verifyPairPut — an attacker's own kid claim buys nothing", () => {
        // The trap wire-api.md names: self-authenticating gets you "signed by
        // whoever holds key A", never a binding of A to a DID. An attacker
        // signs with their OWN key, sets kid to whatever they like, and
        // claims any sender DID in the header. verifyPairPut must still
        // reject unless the CALLER resolved that claimed sender DID's
        // declaration and passed THAT key — which this test does not do,
        // simulating the caller skipping resolution.
        const attacker = keypair()
        const { bytes } = makeEnvelope({
            senderDID: "did:plc:victim000000000000000000000",
            secretKey: attacker.secretKey,
            kid: new Uint8Array(32).fill(0xff), // claims an arbitrary kid
        })
        const envelope = decodePairPutEnvelope(bytes)
        // A verifier that (wrongly) trusted `kid` or the header's sender DID
        // claim would need no resolved key at all. This one requires the
        // caller to supply the resolved key explicitly — passing the
        // attacker's own key here stands in for "the caller correctly
        // resolved did:plc:victim... and got a DIFFERENT key," which is what
        // a real declaration lookup would return.
        const victimsRealKey = keypair().publicKey
        const outcome = verifyPairPut(envelope, victimsRealKey, RECIPIENT_DID)
        expect(outcome.valid).toBe(false)
    })
})

describe("step 4 — recipient DID binding (cross-relay replay)", () => {
    it("rejects when the signed recipient DID is not this recipient", () => {
        const { bytes, publicKey } = makeEnvelope({
            recipientDID: "did:plc:alice0000000000000000000000",
        })
        const envelope = decodePairPutEnvelope(bytes)
        // Simulates the envelope replayed at Carol's relay.
        const outcome = verifyPairPut(
            envelope,
            publicKey,
            "did:plc:carol0000000000000000000000"
        )
        expect(outcome.valid).toBe(false)
    })
})

describe("type/version domain separation", () => {
    it("rejects a header with a different type/version marker", () => {
        expect(PAIR_PUT_TYPE_VERSION).toBe("germ-pmr:pair-put:v1")
        const { secretKey } = keypair()
        const headerMap = new Map<number | string, unknown>([
            [1, -8], // alg = EdDSA
            [4, new Uint8Array(32)], // kid
            [-60001, SENDER_DID],
            [-60002, RECIPIENT_DID],
            [-60003, "germ-pmr:registration:v1"], // wrong marker
            [-60004, new Uint8Array(16)],
        ])
        const protectedHeaderBytes = encodeCose(headerMap as never)
        const payload = new TextEncoder().encode("x")
        const message = encodeCose([
            "Signature1",
            protectedHeaderBytes,
            new Uint8Array(0),
            payload,
        ] as never)
        const signature = ed25519.sign(message, secretKey)
        const envelopeBytes = encodeCose([
            protectedHeaderBytes,
            new Map(),
            payload,
            signature,
        ] as never)

        expect(() => decodePairPutEnvelope(envelopeBytes)).toThrow(/version/)
    })
})

describe("malleability — RFC 8032 §5.1.7 non-canonical signature rejection", () => {
    // Decimal form, cross-checked against @noble/curves' own inlined comment
    // for the same constant — see sign1.ts's CURVE_ORDER for why this form
    // and not a hand-split hex literal.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n

    function withS(bytes: Uint8Array, sValue: bigint): Uint8Array {
        const out = new Uint8Array(bytes)
        for (let i = 0; i < 32; i++) {
            out[32 + i] = Number((sValue >> BigInt(8 * i)) & 0xffn)
        }
        return out
    }

    /** Replaces the signature inside an already-encoded COSE_Sign1 envelope. */
    function withSignature(envelopeBytes: Uint8Array, signature: Uint8Array): Uint8Array {
        const [protectedHeaderBytes, unprotected, payload] =
            decodeCoseArray(envelopeBytes)
        return encodeCose([
            protectedHeaderBytes,
            unprotected,
            payload,
            signature,
        ] as never)
    }

    it("accepts S = L - 1 (boundary, canonical)", () => {
        const { bytes, publicKey } = makeEnvelope()
        const envelope = decodePairPutEnvelope(bytes)
        const canonical = withS(envelope.signature, L - 1n)
        const rebuilt = withSignature(bytes, canonical)
        // Re-decoding must not throw on canonicality...
        const redecoded = decodePairPutEnvelope(rebuilt)
        // ...though it will now fail signature verification, since S changed
        // and no longer matches what was actually signed. This test's job is
        // only to confirm S=L-1 clears the CANONICALITY gate, not that an
        // arbitrary S value verifies.
        expect(redecoded).toBeTruthy()
        void publicKey
    })

    it("rejects S = L (boundary, non-canonical)", () => {
        const { bytes } = makeEnvelope()
        const rebuilt = withSignature(
            bytes,
            withS(decodePairPutEnvelope(bytes).signature, L)
        )
        expect(() => decodePairPutEnvelope(rebuilt)).toThrow(/canonical/)
    })

    it("rejects S = L + 1 (past the boundary, non-canonical)", () => {
        const { bytes } = makeEnvelope()
        const rebuilt = withSignature(
            bytes,
            withS(decodePairPutEnvelope(bytes).signature, L + 1n)
        )
        expect(() => decodePairPutEnvelope(rebuilt)).toThrow(/canonical/)
    })

    it("rejects the maximum possible S (2^256 - 1)", () => {
        const { bytes } = makeEnvelope()
        const rebuilt = withSignature(
            bytes,
            withS(decodePairPutEnvelope(bytes).signature, (1n << 256n) - 1n)
        )
        expect(() => decodePairPutEnvelope(rebuilt)).toThrow(/canonical/)
    })

    it("a genuine ed25519.sign() output is always canonical (sanity check)", () => {
        // Guards against the boundary tests above being vacuous: confirms
        // ordinary signing never PRODUCES a non-canonical S, so the rejection
        // path is exercised only by deliberately-malleated test input, not by
        // spurious rejection of real signatures.
        for (let i = 0; i < 20; i++) {
            const { bytes } = makeEnvelope({
                payload: new Uint8Array([i]),
            })
            expect(() => decodePairPutEnvelope(bytes)).not.toThrow()
        }
    })
})

describe("structural rejections (address-independent, safe to report synchronously)", () => {
    it("rejects a non-4-element array", () => {
        const bytes = encodeCose([new Uint8Array(1), new Map()] as never)
        expect(() => decodePairPutEnvelope(bytes)).toThrow(/4-element/)
    })

    it("rejects a non-empty unprotected header", () => {
        const { bytes } = makeEnvelope()
        const [protectedHeaderBytes, , payload, signature] =
            decodeCoseArray(bytes)
        const tampered = encodeCose([
            protectedHeaderBytes,
            new Map([["evil", 1]]),
            payload,
            signature,
        ] as never)
        expect(() => decodePairPutEnvelope(tampered)).toThrow(/unprotected/)
    })

    it("rejects a wrong alg", () => {
        const { secretKey } = keypair()
        const headerMap = new Map<number | string, unknown>([
            [1, -7], // ES256, not EdDSA
            [4, new Uint8Array(32)],
            [-60001, SENDER_DID],
            [-60002, RECIPIENT_DID],
            [-60003, PAIR_PUT_TYPE_VERSION],
            [-60004, new Uint8Array(16)],
        ])
        const protectedHeaderBytes = encodeCose(headerMap as never)
        const payload = new Uint8Array([1])
        const message = encodeCose([
            "Signature1",
            protectedHeaderBytes,
            new Uint8Array(0),
            payload,
        ] as never)
        const signature = ed25519.sign(message, secretKey)
        const envelopeBytes = encodeCose([
            protectedHeaderBytes,
            new Map(),
            payload,
            signature,
        ] as never)
        expect(() => decodePairPutEnvelope(envelopeBytes)).toThrow(/alg/)
    })

    it("rejects a missing nonce header", () => {
        const { secretKey } = keypair()
        const headerMap = new Map<number | string, unknown>([
            [1, -8],
            [4, new Uint8Array(32)],
            [-60001, SENDER_DID],
            [-60002, RECIPIENT_DID],
            [-60003, PAIR_PUT_TYPE_VERSION],
            // no nonce
        ])
        const protectedHeaderBytes = encodeCose(headerMap as never)
        const payload = new Uint8Array([1])
        const message = encodeCose([
            "Signature1",
            protectedHeaderBytes,
            new Uint8Array(0),
            payload,
        ] as never)
        const signature = ed25519.sign(message, secretKey)
        const envelopeBytes = encodeCose([
            protectedHeaderBytes,
            new Map(),
            payload,
            signature,
        ] as never)
        expect(() => decodePairPutEnvelope(envelopeBytes)).toThrow(/nonce/)
    })
})
