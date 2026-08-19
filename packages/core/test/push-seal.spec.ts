import { gcm } from "@noble/ciphers/aes.js"
import { describe, expect, it } from "vitest"
import {
    PushPayloadTooLargeError,
    SEAL_OVERHEAD_BYTES,
    sealPushPayload,
} from "../src/push/seal"

const CONTENT_KEY = new Uint8Array(32).fill(7)
const KEY_ID = 3

function fixedRandomBytes(byte: number) {
    return (n: number) => new Uint8Array(n).fill(byte)
}

describe("sealPushPayload — layout", () => {
    it("emits key_id(1) || nonce(12) || ciphertext||tag", () => {
        const plaintext = new TextEncoder().encode("hello")
        const sealed = sealPushPayload(plaintext, {
            contentKey: CONTENT_KEY,
            keyId: KEY_ID,
            randomBytes: fixedRandomBytes(0x11),
            maxSealedBytes: 1024,
        })
        expect(sealed.byteLength).toBe(plaintext.byteLength + SEAL_OVERHEAD_BYTES)
        expect(sealed[0]).toBe(KEY_ID)
        expect([...sealed.slice(1, 13)]).toEqual(new Array(12).fill(0x11))
    })

    it("golden-vector interop — pins the exact bytes a client's decoder must match", () => {
        // Fixed key = 0x01 * 32, nonce = 0x02 * 12, keyId = 9, plaintext =
        // "hi". Independently computed with @noble/ciphers directly (not
        // via this module) and hardcoded here, so this test would catch a
        // wire mismatch in THIS module — a byte-order or overhead-size
        // drift — rather than just re-deriving what it already computes.
        // Ideally the same vector is pinned on the client's own decoder.
        const sealed = sealPushPayload(new TextEncoder().encode("hi"), {
            contentKey: new Uint8Array(32).fill(1),
            keyId: 9,
            randomBytes: fixedRandomBytes(2),
            maxSealedBytes: 1024,
        })
        const hex = [...sealed].map((b) => b.toString(16).padStart(2, "0")).join("")
        expect(hex).toBe(
            "090202020202020202020202026fbf81b98921ea37a76a4ab1b877f543f826"
        )
    })

    it("carries no AAD by default — a no-AAD open recovers the plaintext", () => {
        const plaintext = new TextEncoder().encode("no aad here")
        const sealed = sealPushPayload(plaintext, {
            contentKey: CONTENT_KEY,
            keyId: KEY_ID,
            randomBytes: fixedRandomBytes(0x22),
            maxSealedBytes: 1024,
        })
        const nonce = sealed.slice(1, 13)
        const ciphertextAndTag = sealed.slice(13)
        const recovered = gcm(CONTENT_KEY, nonce).decrypt(ciphertextAndTag)
        expect(new TextDecoder().decode(recovered)).toBe("no aad here")
    })

    it("aad is authenticated: a mismatched aad fails to open", () => {
        const plaintext = new TextEncoder().encode("bound to a host")
        const aad = new TextEncoder().encode("relay.example")
        const sealed = sealPushPayload(plaintext, {
            contentKey: CONTENT_KEY,
            keyId: KEY_ID,
            randomBytes: fixedRandomBytes(0x33),
            maxSealedBytes: 1024,
            aad,
        })
        const nonce = sealed.slice(1, 13)
        const ciphertextAndTag = sealed.slice(13)

        // Correct aad opens.
        expect(
            new TextDecoder().decode(
                gcm(CONTENT_KEY, nonce, aad).decrypt(ciphertextAndTag)
            )
        ).toBe("bound to a host")

        // Wrong aad — the GCM tag fails, not a silent wrong-plaintext.
        const wrongAad = new TextEncoder().encode("attacker.example")
        expect(() =>
            gcm(CONTENT_KEY, nonce, wrongAad).decrypt(ciphertextAndTag)
        ).toThrow()
    })

    it("1000 seals through real randomBytes yield 1000 distinct nonces", () => {
        const seen = new Set<string>()
        for (let i = 0; i < 1000; i++) {
            const sealed = sealPushPayload(new Uint8Array([i % 256]), {
                contentKey: CONTENT_KEY,
                keyId: KEY_ID,
                randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
                maxSealedBytes: 1024,
            })
            const nonce = sealed.slice(1, 13)
            seen.add([...nonce].join(","))
        }
        expect(seen.size).toBe(1000)
    })
})

describe("sealPushPayload — size ceiling", () => {
    it("seals exactly at the boundary", () => {
        const maxSealedBytes = 100
        const plaintext = new Uint8Array(maxSealedBytes - SEAL_OVERHEAD_BYTES)
        expect(() =>
            sealPushPayload(plaintext, {
                contentKey: CONTENT_KEY,
                keyId: KEY_ID,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes,
            })
        ).not.toThrow()
    })

    it("throws PushPayloadTooLargeError one byte over the boundary", () => {
        const maxSealedBytes = 100
        const plaintext = new Uint8Array(maxSealedBytes - SEAL_OVERHEAD_BYTES + 1)
        expect(() =>
            sealPushPayload(plaintext, {
                contentKey: CONTENT_KEY,
                keyId: KEY_ID,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes,
            })
        ).toThrow(PushPayloadTooLargeError)
    })
})

describe("sealPushPayload — input validation", () => {
    it("rejects a 31-byte content key", () => {
        expect(() =>
            sealPushPayload(new Uint8Array([1]), {
                contentKey: new Uint8Array(31),
                keyId: KEY_ID,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes: 1024,
            })
        ).toThrow()
    })

    it("rejects a 33-byte content key", () => {
        expect(() =>
            sealPushPayload(new Uint8Array([1]), {
                contentKey: new Uint8Array(33),
                keyId: KEY_ID,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes: 1024,
            })
        ).toThrow()
    })

    it("rejects keyId -1", () => {
        expect(() =>
            sealPushPayload(new Uint8Array([1]), {
                contentKey: CONTENT_KEY,
                keyId: -1,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes: 1024,
            })
        ).toThrow()
    })

    it("rejects keyId 256", () => {
        expect(() =>
            sealPushPayload(new Uint8Array([1]), {
                contentKey: CONTENT_KEY,
                keyId: 256,
                randomBytes: fixedRandomBytes(0),
                maxSealedBytes: 1024,
            })
        ).toThrow()
    })

    it("accepts keyId 0 and keyId 255 — the boundary is inclusive", () => {
        for (const keyId of [0, 255]) {
            expect(() =>
                sealPushPayload(new Uint8Array([1]), {
                    contentKey: CONTENT_KEY,
                    keyId,
                    randomBytes: fixedRandomBytes(0),
                    maxSealedBytes: 1024,
                })
            ).not.toThrow()
        }
    })
})
