/**
 * The relay reads only the policy byte out of a declaration keyPackage
 * (`AnchorHello` wire format), skipping signatures it does not verify.
 */
import { describe, expect, it } from "vitest"
import { allowPoliciesOf, readAnchorPolicy, type AnchorPolicy } from "../src/anchor-policy"

export type PolicyCase = { keyPackage: Uint8Array; expected: AnchorPolicy }

const proof = (keyAlg = 0, sigAlg = 0): number[] => [
    keyAlg,
    ...new Array(32).fill(7),
    sigAlg,
    ...new Array(64).fill(9),
]

/** Hand-built from the documented layout. */
function build(opts: { proofs?: number[][]; policy?: number; tail?: number; outerAlg?: number; proofCount?: number }): Uint8Array {
    const proofs = opts.proofs ?? []
    const pkg = [opts.proofCount ?? proofs.length, ...proofs.flat(), opts.policy ?? 0, ...new Array(opts.tail ?? 3).fill(1)]
    const length = pkg.length < 255 ? [pkg.length] : [255, pkg.length >> 8, pkg.length & 0xff]
    return Uint8Array.from([opts.outerAlg ?? 0, ...new Array(64).fill(5), ...length, ...pkg])
}

describe("readAnchorPolicy", () => {
    it("reads closed / follows / open from a keyPackage with no succession proofs", () => {
        expect(readAnchorPolicy(build({ policy: 0 }))).toBe("closed")
        expect(readAnchorPolicy(build({ policy: 1 }))).toBe("follows")
        expect(readAnchorPolicy(build({ policy: 2 }))).toBe("open")
    })

    it("skips n 98-byte succession proofs before the policy byte", () => {
        expect(readAnchorPolicy(build({ proofs: [proof(), proof(5), proof(3)], policy: 1 }))).toBe("follows")
    })

    it("reads a Package whose Data length uses the 255 + u16 big-endian form", () => {
        const bytes = build({ policy: 2, tail: 400 })
        expect(bytes[65]).toBe(255)
        expect(readAnchorPolicy(bytes)).toBe("open")
    })

    it("an unknown policy byte is { unknown: n }, not an error", () => {
        expect(readAnchorPolicy(build({ policy: 9 }))).toEqual({ unknown: 9 })
    })

    it("throws on a signature algorithm byte other than 0", () => {
        expect(() => readAnchorPolicy(build({ outerAlg: 1 }))).toThrow()
    })

    it("throws when the Package length overruns or does not end the keyPackage", () => {
        const ok = build({ policy: 2 })
        expect(() => readAnchorPolicy(ok.slice(0, ok.length - 1))).toThrow()
        expect(() => readAnchorPolicy(Uint8Array.from([...ok, 0]))).toThrow()
        expect(() => readAnchorPolicy(ok.slice(0, 10))).toThrow()
        expect(() => readAnchorPolicy(new Uint8Array())).toThrow()
    })

    it("throws on a proof count of 255 or proofs that overrun the Package", () => {
        expect(() => readAnchorPolicy(build({ proofCount: 255 }))).toThrow()
        expect(() => readAnchorPolicy(build({ proofs: [proof()], proofCount: 2 }))).toThrow()
    })

    it("throws on a proof whose key-algorithm byte is not 0..5 or whose signature byte is not 0, rather than misreading the policy", () => {
        expect(() => readAnchorPolicy(build({ proofs: [proof(6)], policy: 2 }))).toThrow()
        expect(() => readAnchorPolicy(build({ proofs: [proof(0, 1)], policy: 2 }))).toThrow()
    })
})

describe("allowPoliciesOf", () => {
    it("closed is [], follows is [bsky-follows], open is [open]", () => {
        expect(allowPoliciesOf("closed")).toEqual([])
        expect(allowPoliciesOf("follows")).toEqual(["bsky-follows"])
        expect(allowPoliciesOf("open")).toEqual(["open"])
    })

    it("an unknown byte becomes one unrecognized policy id", () => {
        expect(allowPoliciesOf({ unknown: 7 })).toEqual(["anchor-policy-7"])
    })
})
