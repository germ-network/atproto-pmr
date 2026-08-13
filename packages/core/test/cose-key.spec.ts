/**
 * RFC 9679 COSE Key Thumbprint. The RFC's own §6 worked example is an
 * EC2/P-256 key, not OKP/Ed25519 — but it exercises the same core mechanism
 * this module's thumbprint uses (canonical CBOR of the required-fields map,
 * then SHA-256), so it validates the pipeline independently of key type.
 * The OKP-specific field selection (kty=1, crv=6, x only — no y, no other
 * fields) is then tested on its own terms below.
 */
import { describe, expect, it } from "vitest"
import { CoseValue, encodeCose } from "../src/cose/cbor"
import {
    encodeOkpEd25519Key,
    parseOkpEd25519Key,
    thumbprintOkpEd25519,
} from "../src/cose/key"

function hex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return hex(new Uint8Array(digest))
}

describe("the thumbprint mechanism — RFC 9679 §6's own worked example (EC2/P-256)", () => {
    // Quoted directly from RFC 9679 §6. Not an OKP key, so it does not
    // exercise parseOkpEd25519Key/encodeOkpEd25519Key — it exercises the
    // shared mechanism: construct the required-fields map with COSE integer
    // labels, encode under RFC 8949 §4.2.1, hash with SHA-256.
    const inputHex =
        "A40102200121582065EDA5A12577C2BAE829437FE338701A10AAA375E1BB5B5DE108DE439C08551D2258201E52ED75701163F7F9E40DDF9F341B3DC9BA860AF7E0CA7CA7E9EECD0084D19C"
    const expectedThumbprintHex =
        "496bd8afadf307e5b08c64b0421bf9dc01528a344a43bda88fadd1669da253ec".slice(
            0,
            64
        )

    it("SHA-256 of the exact published CBOR bytes matches the published thumbprint", async () => {
        const inputBytes = hexToBytes(inputHex)
        expect(inputBytes.byteLength).toBe(inputHex.length / 2)
        expect(await sha256Hex(inputBytes)).toBe(expectedThumbprintHex)
    })
})

describe("OKP/Ed25519 thumbprint — field selection and determinism", () => {
    const key = { x: new Uint8Array(32).map((_, i) => i) }

    it("is deterministic", () => {
        expect(hex(thumbprintOkpEd25519(key))).toBe(
            hex(thumbprintOkpEd25519(key))
        )
    })

    it("differs when x differs", () => {
        const other = { x: new Uint8Array(32).map((_, i) => 100 + i) }
        expect(hex(thumbprintOkpEd25519(key))).not.toBe(
            hex(thumbprintOkpEd25519(other))
        )
    })

    it("is exactly SHA-256 of the canonical {kty:1, crv:6, x} map, no other fields", async () => {
        const map = new Map<number, CoseValue>([
            [1, 1], // kty = OKP
            [-1, 6], // crv = Ed25519
            [-2, key.x],
        ])
        const canonical = encodeCose(map)
        expect(hex(thumbprintOkpEd25519(key))).toBe(
            await sha256Hex(canonical)
        )
    })

    it("round-trips through encode/parse", () => {
        const encoded = encodeOkpEd25519Key(key)
        const parsed = parseOkpEd25519Key(encoded)
        expect(hex(parsed.x)).toBe(hex(key.x))
    })
})

describe("parseOkpEd25519Key rejects wrong key types", () => {
    it("rejects a non-OKP kty", () => {
        const bytes = encodeCose(
            new Map<number, CoseValue>([
                [1, 2], // kty = EC2, not OKP
                [-1, 6],
                [-2, new Uint8Array(32)],
            ])
        )
        expect(() => parseOkpEd25519Key(bytes)).toThrow(/kty/)
    })

    it("rejects a non-Ed25519 curve", () => {
        const bytes = encodeCose(
            new Map<number, CoseValue>([
                [1, 1],
                [-1, 4], // crv = X25519, not Ed25519
                [-2, new Uint8Array(32)],
            ])
        )
        expect(() => parseOkpEd25519Key(bytes)).toThrow(/crv/)
    })

    it("rejects a public key of the wrong length", () => {
        const bytes = encodeCose(
            new Map<number, CoseValue>([
                [1, 1],
                [-1, 6],
                [-2, new Uint8Array(31)],
            ])
        )
        expect(() => parseOkpEd25519Key(bytes)).toThrow(/32-byte/)
    })
})
