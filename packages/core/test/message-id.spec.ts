/**
 * Message ids bind their destination mailbox as well as their bytes; a
 * `typedDigest` is a plain content address of the bytes.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { messageIdFor, typedDigest } from "../src/message-id"

const PAYLOAD = new TextEncoder().encode("sealed")
const V = { locator: "locator-v", key: "did:plc:sender" } as const
const B = { locator: "locator-b", key: "did:plc:sender" } as const

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest())
const u16 = (n: number) => Uint8Array.of(n >> 8, n & 0xff)
const utf8 = (s: string) => new TextEncoder().encode(s)
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

describe("typedDigest", () => {
    it("is the algorithm byte followed by SHA-256 of the bytes, hex", () => {
        expect(typedDigest(PAYLOAD)).toBe("01" + hex(sha256(PAYLOAD)))
    })
})

describe("messageIdFor", () => {
    it("matches the specified preimage: domain tag, length-prefixed locator and key, payload digest", () => {
        const L = utf8(V.locator)
        const K = utf8(V.key)
        const preimage = concat(
            utf8("atproto-pmr/message-id/v1"), Uint8Array.of(0),
            u16(L.length), L, u16(K.length), K,
            sha256(PAYLOAD)
        )
        expect(messageIdFor(V, PAYLOAD)).toBe("01" + hex(sha256(preimage)))
    })

    it("is stable for the same destination and bytes, so a retried put dedups", () => {
        expect(messageIdFor(V, PAYLOAD)).toBe(messageIdFor({ ...V }, Uint8Array.from(PAYLOAD)))
    })

    it("differs across registrations for the same mailbox key and bytes", () => {
        expect(messageIdFor(V, PAYLOAD)).not.toBe(messageIdFor(B, PAYLOAD))
    })

    it("differs across mailboxes in one registration for the same bytes", () => {
        expect(messageIdFor(V, PAYLOAD)).not.toBe(messageIdFor({ locator: V.locator, key: "grant:x" }, PAYLOAD))
    })

    it("does not let locator and key bytes slide across their boundary", () => {
        expect(messageIdFor({ locator: "ab", key: "did:c" }, PAYLOAD))
            .not.toBe(messageIdFor({ locator: "a", key: "bdid:c" as `did:${string}` }, PAYLOAD))
    })

    it("is never the content address of the bytes", () => {
        expect(messageIdFor(V, PAYLOAD)).not.toBe(typedDigest(PAYLOAD))
    })

    it("keeps the 66-hex wire shape", () => {
        expect(messageIdFor(V, PAYLOAD)).toMatch(/^01[0-9a-f]{64}$/)
    })
})
