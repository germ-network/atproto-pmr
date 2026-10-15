import type { AllowPolicy } from "./policy.js"

/**
 * Reads the recipient's signed messaging policy out of a declaration's
 * `keyPackage`: the `AnchorHello` wire format. The relay
 * does not verify the signatures (devices do); it only needs the policy,
 * so it skips everything before it and reads nothing after.
 *
 * Linear encoding: fields concatenate with no tags. `Data` has a one-byte
 * length (1..254; 255 means a big-endian u16 length follows), an array a
 * one-byte count (255 reserved), an enum one byte. The path is
 * `AnchorHello{TypedSignature(65), Data(Package)}` → `Package{Content, …}` →
 * `Content{[Proof(98)], AnchorPolicy, …}`.
 */

/** The declaration's signed `AnchorPolicy`; `unknown` carries a byte this relay does not know. */
export type AnchorPolicy = "closed" | "follows" | "open" | { unknown: number }

const SIGNATURE_ALG_ED25519 = 0
const SIGNATURE_BYTES = 64
const KEY_BYTES = 32
const MAX_KEY_ALG = 5

/** Throws on a keyPackage that does not parse as far as the policy byte. */
export function readAnchorPolicy(keyPackage: Uint8Array): AnchorPolicy {
    const fail = (why: string): never => {
        throw new Error(`malformed keyPackage: ${why}`)
    }
    let at = 0
    const need = (n: number, end: number): void => {
        if (at + n > end) fail("truncated")
    }

    need(1 + SIGNATURE_BYTES, keyPackage.length)
    if (keyPackage[at] !== SIGNATURE_ALG_ED25519) fail("signature algorithm")
    at += 1 + SIGNATURE_BYTES

    need(1, keyPackage.length)
    let length = keyPackage[at]!
    at += 1
    if (length === 255) {
        need(2, keyPackage.length)
        length = (keyPackage[at]! << 8) | keyPackage[at + 1]!
        at += 2
    }
    if (length === 0) fail("empty package")
    const end = at + length
    if (end !== keyPackage.length) fail("package length")

    need(1, end)
    const proofs = keyPackage[at]!
    at += 1
    if (proofs === 255) fail("proof count")
    for (let i = 0; i < proofs; i++) {
        need(1 + KEY_BYTES + 1 + SIGNATURE_BYTES, end)
        if (keyPackage[at]! > MAX_KEY_ALG) fail("proof key algorithm")
        at += 1 + KEY_BYTES
        if (keyPackage[at] !== SIGNATURE_ALG_ED25519) fail("proof signature algorithm")
        at += 1 + SIGNATURE_BYTES
    }

    need(1, end)
    const byte = keyPackage[at]!
    if (byte === 0) return "closed"
    if (byte === 1) return "follows"
    if (byte === 2) return "open"
    return { unknown: byte }
}

/**
 * `closed` declares no policy; `follows` is the Bluesky follow graph; an
 * unknown byte becomes a policy id this relay reports as unrecognized.
 */
export function allowPoliciesOf(policy: AnchorPolicy): AllowPolicy[] {
    if (policy === "closed") return []
    if (policy === "follows") return ["bsky-follows"]
    if (policy === "open") return ["open"]
    return [`anchor-policy-${policy.unknown}`]
}
