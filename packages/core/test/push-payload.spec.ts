import { describe, expect, it } from "vitest"
import { decodeCoseMap } from "../src/cose/cbor"
import {
    buildDeclarationPushPayload,
    buildMessagePushPayload,
    buildPoolPushPayload,
} from "../src/push/payload"
import { SEAL_OVERHEAD_BYTES } from "../src/push/seal"
import type { MessageRef } from "../src/storage"

const KEY = "did:plc:alice" as const
const REF: MessageRef = { messageId: "m1", byteLength: 5 }
const REF_WITH_HINT: MessageRef = {
    messageId: "m1",
    byteLength: 5,
    hint: { senderDID: "did:plc:bob", anchorKeyThumbprint: "th" },
}

describe("buildMessagePushPayload — fits", () => {
    it("includes m, sd, kt when the sealed total fits", () => {
        const message = new TextEncoder().encode("hello")
        const bytes = buildMessagePushPayload({
            key: KEY,
            ref: REF_WITH_HINT,
            message,
            maxSealedBytes: 10_000,
        })
        const map = decodeCoseMap(bytes)
        expect(map.get("t")).toBe("m")
        expect(map.get("k")).toBe(KEY)
        expect(map.get("id")).toBe("m1")
        expect(new TextDecoder().decode(map.get("m") as Uint8Array)).toBe("hello")
        expect(map.get("sd")).toBe("did:plc:bob")
        expect(map.get("kt")).toBe("th")
    })

    it("omits sd/kt for a grant-mailbox ref (no hint)", () => {
        const message = new TextEncoder().encode("hello")
        const bytes = buildMessagePushPayload({
            key: "grant:abc",
            ref: REF,
            message,
            maxSealedBytes: 10_000,
        })
        const map = decodeCoseMap(bytes)
        expect(map.has("sd")).toBe(false)
        expect(map.has("kt")).toBe(false)
    })
})

describe("buildMessagePushPayload — falls back to pointer-only when it doesn't fit", () => {
    it("drops m/sd/kt and keeps only t/k/id when the full form would exceed maxSealedBytes", () => {
        const message = new Uint8Array(5000).fill(65) // way over any reasonable ceiling
        const bytes = buildMessagePushPayload({
            key: KEY,
            ref: REF_WITH_HINT,
            message,
            maxSealedBytes: 200,
        })
        const map = decodeCoseMap(bytes)
        expect(map.get("t")).toBe("m")
        expect(map.get("k")).toBe(KEY)
        expect(map.get("id")).toBe("m1")
        expect(map.has("m")).toBe(false)
        expect(map.has("sd")).toBe(false)
        expect(map.has("kt")).toBe(false)
    })

    it("the fallback form itself fits within maxSealedBytes once sealed", () => {
        const message = new Uint8Array(5000).fill(65)
        const bytes = buildMessagePushPayload({
            key: KEY,
            ref: REF_WITH_HINT,
            message,
            maxSealedBytes: 200,
        })
        expect(bytes.byteLength + SEAL_OVERHEAD_BYTES).toBeLessThanOrEqual(200)
    })

    it("picks the full form when it fits exactly at the boundary", () => {
        const message = new TextEncoder().encode("x")
        const full = buildMessagePushPayload({
            key: KEY,
            ref: REF,
            message,
            maxSealedBytes: 10_000,
        })
        const atExactBoundary = buildMessagePushPayload({
            key: KEY,
            ref: REF,
            message,
            maxSealedBytes: full.byteLength + SEAL_OVERHEAD_BYTES,
        })
        expect(decodeCoseMap(atExactBoundary).has("m")).toBe(true)

        const oneByteUnder = buildMessagePushPayload({
            key: KEY,
            ref: REF,
            message,
            maxSealedBytes: full.byteLength + SEAL_OVERHEAD_BYTES - 1,
        })
        expect(decodeCoseMap(oneByteUnder).has("m")).toBe(false)
    })
})

describe("buildPoolPushPayload / buildDeclarationPushPayload", () => {
    it("pool payload is exactly {t: 'p'}", () => {
        const map = decodeCoseMap(buildPoolPushPayload())
        expect([...map.entries()]).toEqual([["t", "p"]])
    })

    it("declaration payload is exactly {t: 'd'}", () => {
        const map = decodeCoseMap(buildDeclarationPushPayload())
        expect([...map.entries()]).toEqual([["t", "d"]])
    })
})
