import { describe, expect, it } from "vitest"
import {
    computeGrantPutTag,
    deriveGrantAddress,
    verifyGrantPutTag,
} from "../src/grant"

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return out
}

function rangeBytes(start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start)
    for (let i = 0; i < out.length; i++) {
        out[i] = start + i
    }
    return out
}

const ZERO_KEY = new Uint8Array(32)
// The address these vectors are built on: deriveGrantAddress(ZERO_KEY, "ger.mx").
const ADDRESS_STRING = "lXoAYEVUjLGCQmEXp55sYzcnh46BUe5-eTgCb7LKz28"

describe("deriveGrantAddress — known-answer test", () => {
    // Independently computed: hmac.new(bytes(32),
    //   b"germ-pmr:grant-addr:v1" + b"ger.mx", sha256).hexdigest()
    it("matches an independently computed HMAC-SHA256", () => {
        const address = deriveGrantAddress(ZERO_KEY, "ger.mx")
        expect(address).toEqual(
            hexToBytes(
                "957a006045548cb182426117a79e6c633727878e8151ee7e7938026fb2cacf6f".slice(
                    0,
                    64
                )
            )
        )
    })

    it("differs by host (domain separation of the variable field)", () => {
        const a = deriveGrantAddress(ZERO_KEY, "ger.mx")
        const b = deriveGrantAddress(ZERO_KEY, "other.example")
        expect(a).not.toEqual(b)
        // Independently computed against "other.example".
        expect(b).toEqual(
            hexToBytes(
                "8f3ec8cacb66ad9eba7ea29554a547d0d8271b44ed0aff28b58d8ae759d4eab8".slice(
                    0,
                    64
                )
            )
        )
    })

    it("differs by key", () => {
        const key2 = new Uint8Array(32).fill(1)
        const a = deriveGrantAddress(ZERO_KEY, "ger.mx")
        const b = deriveGrantAddress(key2, "ger.mx")
        expect(a).not.toEqual(b)
        // Independently computed under key2.
        expect(b).toEqual(
            hexToBytes(
                "5fabab601a24b20be76a34b2343e0a5fc305e42b40a283fbfc1378c8a27454ef".slice(
                    0,
                    64
                )
            )
        )
    })

    it("is deterministic", () => {
        const a = deriveGrantAddress(ZERO_KEY, "ger.mx")
        const b = deriveGrantAddress(ZERO_KEY, "ger.mx")
        expect(a).toEqual(b)
    })

    it("rejects a key that is not 32 bytes", () => {
        expect(() => deriveGrantAddress(new Uint8Array(16), "ger.mx")).toThrow(
            "32 bytes"
        )
    })
})

describe("computeGrantPutTag / verifyGrantPutTag — known-answer test", () => {
    const nonce = rangeBytes(0, 32)
    const digest = rangeBytes(32, 64)

    // Independently computed: hmac.new(bytes(32),
    //   b"germ-pmr:grant-put:v1" + ADDRESS_STRING.encode()
    //     + bytes(range(32)) + bytes(range(32,64)),
    //   sha256).hexdigest()
    it("matches an independently computed HMAC-SHA256", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        expect(tag).toEqual(
            hexToBytes(
                "21691c49aeb4dd1cde5600ae404e554874f1c5383b6a7d7f4b3ec52aea914933".slice(
                    0,
                    64
                )
            )
        )
    })

    it("verifies a correctly computed tag", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        expect(verifyGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest, tag)).toBe(
            true
        )
    })

    it("rejects a tag computed under a different key", () => {
        const otherKey = new Uint8Array(32).fill(1)
        const tag = computeGrantPutTag(otherKey, ADDRESS_STRING, nonce, digest)
        expect(verifyGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest, tag)).toBe(
            false
        )
        // Independently computed under key2.
        expect(tag).toEqual(
            hexToBytes(
                "2743675da005e36981999bdd805bd25a69b841a14110c00b3f254b602e65c8fd".slice(
                    0,
                    64
                )
            )
        )
    })

    it("rejects a tag when the address differs (grant-scoping)", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        const otherAddress = "different-address-string-0000000000000000".slice(0, 43)
        expect(
            verifyGrantPutTag(ZERO_KEY, otherAddress, nonce, digest, tag)
        ).toBe(false)
    })

    it("rejects a tag when the nonce differs (freshness binding)", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        const otherNonce = rangeBytes(1, 33)
        expect(
            verifyGrantPutTag(ZERO_KEY, ADDRESS_STRING, otherNonce, digest, tag)
        ).toBe(false)
    })

    it("rejects a tag when the body digest differs (body binding)", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        const otherDigest = rangeBytes(0, 32)
        expect(
            verifyGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, otherDigest, tag)
        ).toBe(false)
    })

    it("rejects a bit-flipped tag", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        const flipped = new Uint8Array(tag)
        flipped[0] ^= 0x01
        expect(
            verifyGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest, flipped)
        ).toBe(false)
    })

    it("rejects a truncated tag rather than reading out of bounds", () => {
        const tag = computeGrantPutTag(ZERO_KEY, ADDRESS_STRING, nonce, digest)
        expect(
            verifyGrantPutTag(
                ZERO_KEY,
                ADDRESS_STRING,
                nonce,
                digest,
                tag.slice(0, 16)
            )
        ).toBe(false)
    })

    it("rejects a key that is not 32 bytes", () => {
        expect(() =>
            computeGrantPutTag(new Uint8Array(16), ADDRESS_STRING, nonce, digest)
        ).toThrow("32 bytes")
    })
})
