/**
 * COSE_Key for AKP/ML-DSA-65 (RFC 9964 §3, §6) and the key-type dispatch
 * over it. The Ed25519 functions stay exactly as they were; these tests pin
 * that the dispatching parser hands each key type to its own strict parser
 * and never lets one type pass as the other.
 */
import { readFileSync } from "node:fs"
import { sha256 } from "@noble/hashes/sha2.js"
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"
import { describe, expect, it } from "vitest"
import { CoseValue, encodeCose } from "../src/cose/cbor"
import {
    encodeAkpMlDsa65Key,
    encodeCosePublicKey,
    encodeOkpEd25519Key,
    parseAkpMlDsa65Key,
    parseCosePublicKey,
    parseOkpEd25519Key,
    thumbprintAkpMlDsa65,
    thumbprintCosePublicKey,
    thumbprintOkpEd25519,
} from "../src/cose/key"

// The vectors are owned by spec/, read in place and never copied.
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

const pub = fromHex(vectors.key.pub)

function akpMap(
    overrides: Array<[number, CoseValue]> = [],
    drop: number[] = []
): Uint8Array {
    const map = new Map<number | string, CoseValue>([
        [1, 7],
        [3, -49],
        [-1, pub],
    ])
    for (const label of drop) map.delete(label)
    for (const [label, value] of overrides) map.set(label, value)
    return encodeCose(map)
}

describe("AKP/ML-DSA-65 COSE_Key", () => {
    it("round-trips a 1952-byte pub through encode and parse", () => {
        const parsed = parseAkpMlDsa65Key(encodeAkpMlDsa65Key({ pub }))
        expect(hex(parsed.pub)).toBe(hex(pub))
    })

    it("encodes exactly a3 01 07 03 38 30 20 59 07 a0 || pub, the {1: 7, 3: -49, -1: pub} map in RFC 8949 §4.2.1 order", () => {
        expect(hex(encodeAkpMlDsa65Key({ pub }))).toBe(
            "a30107033830205907a0" + hex(pub)
        )
    })

    it("rejects a kty other than AKP(7)", () => {
        expect(() => parseAkpMlDsa65Key(akpMap([[1, 1]]))).toThrow(/kty/)
    })

    it("rejects an AKP key whose alg is missing", () => {
        expect(() => parseAkpMlDsa65Key(akpMap([], [3]))).toThrow(/alg/)
    })

    it("rejects an AKP key whose alg is ML-DSA-44 or ML-DSA-87", () => {
        expect(() => parseAkpMlDsa65Key(akpMap([[3, -48]]))).toThrow(/alg/)
        expect(() => parseAkpMlDsa65Key(akpMap([[3, -50]]))).toThrow(/alg/)
    })

    it("rejects a pub that is not exactly 1952 bytes", () => {
        for (const length of [0, 1312, 1951, 1953, 2592]) {
            expect(() =>
                parseAkpMlDsa65Key(akpMap([[-1, new Uint8Array(length)]]))
            ).toThrow(/pub/)
        }
    })

    it("rejects a key that carries priv", () => {
        expect(() =>
            parseAkpMlDsa65Key(akpMap([[-2, new Uint8Array(32)]]))
        ).toThrow(/priv/)
    })

    it("rejects a pub that is not a byte string", () => {
        expect(() => parseAkpMlDsa65Key(akpMap([[-1, "x".repeat(1952)]]))).toThrow(
            /pub/
        )
    })

    it("rejects an alg that is not an integer", () => {
        expect(() => parseAkpMlDsa65Key(akpMap([[3, "ML-DSA-65"]]))).toThrow(
            /alg/
        )
    })

    it("rejects an AKP map that is not canonically ordered", () => {
        const canonical = encodeAkpMlDsa65Key({ pub })
        // a3 | 01 07 | 03 38 30 | 20 59 07a0 pub  ->  swap the first two pairs
        const swapped = new Uint8Array(canonical.length)
        swapped.set(canonical.subarray(0, 1), 0)
        swapped.set(canonical.subarray(3, 6), 1)
        swapped.set(canonical.subarray(1, 3), 4)
        swapped.set(canonical.subarray(6), 6)
        expect(hex(swapped).slice(0, 20)).toBe("a30338300107205907a0")
        expect(() => parseAkpMlDsa65Key(swapped)).toThrow(/canonical/)
    })

    it("ignores labels it does not recognise, as the OKP parser does", () => {
        const parsed = parseAkpMlDsa65Key(akpMap([[2, new Uint8Array(32)]]))
        expect(hex(parsed.pub)).toBe(hex(pub))
    })
})

describe("RFC 9964 Appendix A, Figure 7 (ML-DSA-65, all-zero seed)", () => {
    // Read from spec/vectors/ml-dsa-65.json, where they were copied from
    // the RFC's .txt: an implementation-independent check of keygen and of
    // the thumbprint's field set and order. A mismatch is a finding to
    // raise, not a value to update.
    const fig7 = vectors.rfc9964_figure7

    it("keygen of the all-zero seed yields the figure's pub", () => {
        const { publicKey } = ml_dsa65.keygen(fromHex(fig7.seed))
        expect(hex(publicKey)).toBe(fig7.pub)
    })

    it("the thumbprint of the figure's key equals the figure's kid", () => {
        expect(hex(thumbprintAkpMlDsa65({ pub: fromHex(fig7.pub) }))).toBe(
            fig7.kid
        )
    })
})

describe("AKP/ML-DSA-65 thumbprint (RFC 9679 over RFC 9964 §6's required parameters)", () => {
    it("is exactly SHA-256 of the canonical {kty, alg, pub} map, no other fields", () => {
        const input = encodeCose(
            new Map<number, CoseValue>([
                [1, 7],
                [3, -49],
                [-1, pub],
            ])
        )
        expect(hex(thumbprintAkpMlDsa65({ pub }))).toBe(hex(sha256(input)))
        expect(hex(thumbprintAkpMlDsa65({ pub }))).toBe(
            vectors.key.thumbprint_hex
        )
        expect(hex(fromHex(vectors.key.thumbprint_input))).toBe(hex(input))
    })

    it("does not change when the COSE_Key carries an extra parameter such as kid", () => {
        const withKid = parseAkpMlDsa65Key(akpMap([[2, new Uint8Array(32)]]))
        expect(hex(thumbprintAkpMlDsa65(withKid))).toBe(
            hex(thumbprintAkpMlDsa65({ pub }))
        )
    })

    it("differs when pub differs", () => {
        const other = pub.slice()
        other[0] ^= 1
        expect(hex(thumbprintAkpMlDsa65({ pub: other }))).not.toBe(
            hex(thumbprintAkpMlDsa65({ pub }))
        )
    })
})

describe("parseCosePublicKey dispatches on kty", () => {
    const x = new Uint8Array(32).map((_, i) => i + 1)

    it("returns an OKP/Ed25519 key for an Ed25519 COSE_Key, matching parseOkpEd25519Key", () => {
        const parsed = parseCosePublicKey(encodeOkpEd25519Key({ x }))
        expect(parsed.kty).toBe("OKP")
        expect(hex(parsed.kty === "OKP" ? parsed.x : new Uint8Array())).toBe(
            hex(parseOkpEd25519Key(encodeOkpEd25519Key({ x })).x)
        )
    })

    it("returns an AKP/ML-DSA-65 key for an AKP COSE_Key, matching parseAkpMlDsa65Key", () => {
        const bytes = encodeAkpMlDsa65Key({ pub })
        const parsed = parseCosePublicKey(bytes)
        expect(parsed.kty).toBe("AKP")
        expect(hex(parsed.kty === "AKP" ? parsed.pub : new Uint8Array())).toBe(
            hex(parseAkpMlDsa65Key(bytes).pub)
        )
    })

    it("rejects every other kty, including EC2 and Symmetric", () => {
        for (const kty of [2, 4, 3, 0]) {
            expect(() =>
                parseCosePublicKey(encodeCose(new Map([[1, kty]])))
            ).toThrow(/kty/)
        }
    })

    it("applies each type's strict parser rather than just reading its fields", () => {
        expect(() =>
            parseCosePublicKey(akpMap([[-2, new Uint8Array(32)]]))
        ).toThrow(/priv/)
        expect(() => parseCosePublicKey(akpMap([[3, -48]]))).toThrow(/alg/)
        expect(() =>
            parseCosePublicKey(akpMap([[-1, new Uint8Array(1951)]]))
        ).toThrow(/pub/)
        expect(() =>
            parseCosePublicKey(
                encodeCose(
                    new Map<number, CoseValue>([
                        [1, 1],
                        [-1, 7],
                        [-2, x],
                    ])
                )
            )
        ).toThrow(/crv/)
    })

    it("thumbprintCosePublicKey agrees with the per-type thumbprint for both types", () => {
        const okp = parseCosePublicKey(encodeOkpEd25519Key({ x }))
        const akp = parseCosePublicKey(encodeAkpMlDsa65Key({ pub }))
        expect(hex(thumbprintCosePublicKey(okp))).toBe(
            hex(thumbprintOkpEd25519({ x }))
        )
        expect(hex(thumbprintCosePublicKey(akp))).toBe(
            hex(thumbprintAkpMlDsa65({ pub }))
        )
    })

    it("encodeCosePublicKey of an OKP key equals encodeOkpEd25519Key", () => {
        const okp = parseCosePublicKey(encodeOkpEd25519Key({ x }))
        expect(hex(encodeCosePublicKey(okp))).toBe(
            hex(encodeOkpEd25519Key({ x }))
        )
        const akp = parseCosePublicKey(encodeAkpMlDsa65Key({ pub }))
        expect(hex(encodeCosePublicKey(akp))).toBe(
            hex(encodeAkpMlDsa65Key({ pub }))
        )
    })
})
