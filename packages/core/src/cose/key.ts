/**
 * COSE_Key (RFC 9052 §7) for the OKP/Ed25519 case — the only key type this
 * endpoint needs, since the anchor key is Ed25519 (launch
 * classical, algorithm-agile — a PQ algorithm arrives as a new `alg`
 * identifier here, never a schema change).
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
