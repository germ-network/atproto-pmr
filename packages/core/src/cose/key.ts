/**
 * COSE_Key (RFC 9052 §7) for the two key types an RFC 9421 signer may hold:
 * OKP/Ed25519, which every anchor key is, and AKP/ML-DSA-65 (RFC 9964),
 * which a registration-realm key may be. A new algorithm is a new key type
 * and `alg` identifier here, never a schema change.
 *
 * Also RFC 9679 COSE Key Thumbprints, which is what `kid` carries on the
 * wire (wire-api.md §Conventions: "`keyid` carrying the RFC 9679 COSE Key
 * Thumbprint"). `kid` is diagnostic only — see cose/sign1.ts's verification
 * algorithm for why nothing here is ever verified against.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { CoseValue, decodeCoseMap, encodeCose } from "./cbor"

// COSE Key Common Parameters (RFC 9052 §7.1)
const LABEL_KTY = 1
// COSE Key Type Parameters, OKP (RFC 9053 §7.2)
const LABEL_CRV = -1
const LABEL_X = -2

// COSE Key Types (RFC 9053 §7.1)
const KTY_OKP = 1
// COSE Elliptic Curves (RFC 9053 §7.2.1)
const CRV_ED25519 = 6

export interface OkpEd25519Key {
    /** The raw 32-byte Ed25519 public key. */
    x: Uint8Array
}

/**
 * Parses a COSE_Key CBOR structure, accepting only the OKP/Ed25519 case.
 * Any other `kty`/`crv` is rejected rather than passed through — there is no
 * other anchor key type to accept yet, and a permissive parser here would be
 * new attack surface for zero benefit.
 */
export function parseOkpEd25519Key(bytes: Uint8Array): OkpEd25519Key {
    const map = decodeCoseMap(bytes)

    const kty = map.get(LABEL_KTY)
    if (kty !== KTY_OKP) {
        throw new Error(`COSE_Key: expected kty=OKP(1), got ${String(kty)}`)
    }
    const crv = map.get(LABEL_CRV)
    if (crv !== CRV_ED25519) {
        throw new Error(`COSE_Key: expected crv=Ed25519(6), got ${String(crv)}`)
    }
    const x = map.get(LABEL_X)
    if (!(x instanceof Uint8Array) || x.byteLength !== 32) {
        throw new Error("COSE_Key: x must be a 32-byte Ed25519 public key")
    }

    return { x }
}

export function encodeOkpEd25519Key(key: OkpEd25519Key): Uint8Array {
    const map = new Map<number | string, CoseValue>([
        [LABEL_KTY, KTY_OKP],
        [LABEL_CRV, CRV_ED25519],
        [LABEL_X, key.x],
    ])
    return encodeCose(map)
}

/**
 * RFC 9679 COSE Key Thumbprint: a canonical CBOR map of the key's REQUIRED
 * fields only, hashed with SHA-256 (the mandatory default; RFC 9679 permits
 * others, this profile pins one). For OKP that's exactly `kty`, `crv`, `x` —
 * the same three fields `parseOkpEd25519Key` requires, so an Ed25519
 * COSE_Key and its thumbprint input are the same map, canonically encoded.
 *
 * Map key order follows RFC 8949 §4.2.1: sorted by the *encoded* key bytes.
 * For labels 1, -1, -2 the canonical CBOR encodings are 0x01, 0x20, 0x21 —
 * already ascending, so `kty, crv, x` is both the natural definition order
 * and the canonical wire order; `encodeCose` (RFC 8949 §4.2.1 options)
 * enforces this regardless of the `Map`'s insertion order.
 *
 * The core mechanism (canonical-CBOR-of-required-fields, then SHA-256) is
 * verified in `test/cose-key.spec.ts` against RFC 9679 §6's own published
 * worked example — an EC2/P-256 key, not OKP, but the same pipeline.
 */
export function thumbprintOkpEd25519(key: OkpEd25519Key): Uint8Array {
    return sha256(encodeOkpEd25519Key(key))
}

// COSE Key Common Parameters (RFC 9052 §7.1)
const LABEL_ALG = 3
// COSE Key Type Parameters, AKP (RFC 9964 §8.1.3)
const LABEL_AKP_PUB = -1
const LABEL_AKP_PRIV = -2

// COSE Key Types (RFC 9964 §8.1.2.1)
const KTY_AKP = 7
// COSE Algorithms (RFC 9964 §8.1.1.2)
const ALG_ML_DSA_65 = -49

/** FIPS 204 ML-DSA-65 public key length (RFC 9964 §5, Table 1). */
export const ML_DSA_65_PUBLIC_KEY_BYTES = 1952

export interface AkpMlDsa65Key {
    /** The raw 1952-byte ML-DSA-65 public key. */
    pub: Uint8Array
}

/**
 * A public key that signs an RFC 9421 request, tagged by its COSE key type.
 * The verifier picks the algorithm from this tag, never from the message.
 */
export type CosePublicKey =
    | ({ kty: "OKP"; crv: "Ed25519" } & OkpEd25519Key)
    | ({ kty: "AKP"; alg: "ML-DSA-65" } & AkpMlDsa65Key)

/**
 * Parses a COSE_Key, accepting only AKP with `alg` = ML-DSA-65 and a
 * 1952-byte `pub`. A `priv` parameter is refused: RFC 9964 §3 says it MUST
 * NOT be present in a public key, and a stored blob that carries one is a
 * leaked secret, not a registration.
 */
export function parseAkpMlDsa65Key(bytes: Uint8Array): AkpMlDsa65Key {
    const map = decodeCoseMap(bytes)

    const kty = map.get(LABEL_KTY)
    if (kty !== KTY_AKP) {
        throw new Error(`COSE_Key: expected kty=AKP(7), got ${String(kty)}`)
    }
    const alg = map.get(LABEL_ALG)
    if (alg !== ALG_ML_DSA_65) {
        throw new Error(
            `COSE_Key: expected alg=ML-DSA-65(-49), got ${String(alg)}`
        )
    }
    if (map.has(LABEL_AKP_PRIV)) {
        throw new Error("COSE_Key: a public key must not carry priv")
    }
    const pub = map.get(LABEL_AKP_PUB)
    if (
        !(pub instanceof Uint8Array) ||
        pub.byteLength !== ML_DSA_65_PUBLIC_KEY_BYTES
    ) {
        throw new Error(
            `COSE_Key: pub must be a ${ML_DSA_65_PUBLIC_KEY_BYTES}-byte ML-DSA-65 public key`
        )
    }

    return { pub }
}

/** The map the thumbprint hashes: the required parameters and no others. */
function akpRequiredMap(key: AkpMlDsa65Key): Map<number, CoseValue> {
    return new Map<number, CoseValue>([
        [LABEL_KTY, KTY_AKP],
        [LABEL_ALG, ALG_ML_DSA_65],
        [LABEL_AKP_PUB, key.pub],
    ])
}

export function encodeAkpMlDsa65Key(key: AkpMlDsa65Key): Uint8Array {
    return encodeCose(akpRequiredMap(key))
}

/**
 * RFC 9679 thumbprint of an AKP key: SHA-256 of the canonical CBOR map of
 * exactly `kty`, `alg`, `pub` (RFC 9964 §6). Unlike OKP, `alg` is a required
 * member.
 */
export function thumbprintAkpMlDsa65(key: AkpMlDsa65Key): Uint8Array {
    return sha256(encodeAkpMlDsa65Key(key))
}

/** Parses a COSE_Key of any type this profile accepts, dispatching on `kty`. */
export function parseCosePublicKey(bytes: Uint8Array): CosePublicKey {
    const kty = decodeCoseMap(bytes).get(LABEL_KTY)
    switch (kty) {
        case KTY_OKP:
            return { kty: "OKP", crv: "Ed25519", ...parseOkpEd25519Key(bytes) }
        case KTY_AKP:
            return { kty: "AKP", alg: "ML-DSA-65", ...parseAkpMlDsa65Key(bytes) }
        default:
            throw new Error(
                `COSE_Key: unsupported kty ${String(kty)}, expected OKP(1) or AKP(7)`
            )
    }
}

export function encodeCosePublicKey(key: CosePublicKey): Uint8Array {
    return key.kty === "OKP" ? encodeOkpEd25519Key(key) : encodeAkpMlDsa65Key(key)
}

export function thumbprintCosePublicKey(key: CosePublicKey): Uint8Array {
    return key.kty === "OKP"
        ? thumbprintOkpEd25519(key)
        : thumbprintAkpMlDsa65(key)
}
