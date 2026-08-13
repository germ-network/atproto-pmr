/**
 * Deterministic CBOR (RFC 8949 §4.2.1) for COSE structures, over `cborg`.
 *
 * Scoped to COSE's grammar specifically: integer-labeled header maps,
 * arrays, and byte strings. A CBOR wrapper narrowed to text-string map keys
 * — a common shape for a JSON-ish API — cannot be reused here, and
 * loosening one to cover both widens the accepted grammar on every surface
 * that shares it.
 *
 * Same deterministic-CBOR discipline applies regardless of grammar: accept exactly RFC
 * 8949 §4.2.1, emit the stricter dCBOR subset, and reject anything that is
 * not canonically encoded by re-encoding and comparing byte-for-byte. An
 * implementation emitting plain §4.2.1 (not dCBOR) MUST still be accepted —
 * dCBOR is what this encoder produces, not the bar an input is judged
 * against.
 */

import { decodeFirst, encode, rfc8949EncodeOptions } from "cborg"

export type CoseValue =
    | number
    | Uint8Array
    | string
    | boolean
    | null
    | Map<number | string, CoseValue>
    | CoseValue[]

const DECODE_OPTIONS = {
    strict: true,
    rejectDuplicateMapKeys: true,
    useMaps: true,
    allowIndefinite: false,
    allowUndefined: false,
    allowInfinity: false,
    allowNaN: false,
    allowBigInt: false,
} as const

const ENCODE_OPTIONS = rfc8949EncodeOptions

/**
 * The COSE header-map and COSE_Sign1-array grammar: maps keyed by integer or
 * short text string (RFC 9052 labels may be either), byte strings, text
 * strings, booleans, null, non-negative and negative safe integers, and
 * arrays of the same. No tags, no floats, no bignums — nothing this profile
 * needs.
 */
function assertCoseGrammar(value: unknown): void {
    if (
        value instanceof Uint8Array ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        value === null
    ) {
        return
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error("COSE/CBOR: only safe integers are supported")
        }
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) assertCoseGrammar(item)
        return
    }
    if (value instanceof Map) {
        for (const [key, item] of value) {
            if (typeof key !== "number" && typeof key !== "string") {
                throw new Error(
                    "COSE/CBOR: map keys must be integers or text strings"
                )
            }
            if (typeof key === "number" && !Number.isSafeInteger(key)) {
                throw new Error(
                    "COSE/CBOR: integer map keys must be safe integers"
                )
            }
            assertCoseGrammar(item)
        }
        return
    }
    throw new Error("COSE/CBOR: unsupported value type in decoded input")
}

/**
 * Decodes exactly one top-level value under the pinned options, narrows it
 * to the COSE grammar, requires it to have been in canonical form, and
 * returns whatever bytes follow it — which the caller decides whether to
 * treat as an error (a single value expected) or as the next value in a
 * sequence (concatenated top-level values, atproto's own framing
 * convention for e.g. a header immediately followed by a body).
 *
 * The re-encode round trip is the actual determinism check, and it is
 * stronger than any decode flag: re-encoding under RFC 8949 §4.2.1 produces
 * *the* canonical encoding of the value, so if that does not reproduce the
 * input byte for byte, the input was not canonical. That catches the whole
 * class at once — non-minimal integers, an integer sent as a float (which
 * decodes to an indistinguishable number, so no type check can see it), and
 * out-of-order map keys.
 */
function decodeOneCanonical(bytes: Uint8Array): [unknown, Uint8Array] {
    const [value, remainder] = decodeFirst(bytes, DECODE_OPTIONS)
    assertCoseGrammar(value)

    const consumed = bytes.length - remainder.length
    const canonical = encode(value, ENCODE_OPTIONS)
    if (canonical.length !== consumed) {
        throw new Error("COSE/CBOR: input is not canonically encoded")
    }
    for (let i = 0; i < canonical.length; i++) {
        if (canonical[i] !== bytes[i]) {
            throw new Error("COSE/CBOR: input is not canonically encoded")
        }
    }
    return [value, remainder]
}

function decodeNarrow(bytes: Uint8Array): unknown {
    const [value, remainder] = decodeOneCanonical(bytes)
    if (remainder.length > 0) {
        throw new Error("COSE/CBOR: too many terminals, data makes no sense")
    }
    return value
}

export function encodeCose(value: CoseValue): Uint8Array {
    return encode(value, ENCODE_OPTIONS)
}

/** Decodes a single top-level CBOR value expected to be an array (COSE_Sign1). */
export function decodeCoseArray(bytes: Uint8Array): CoseValue[] {
    const value = decodeNarrow(bytes)
    if (!Array.isArray(value)) {
        throw new Error("COSE/CBOR: expected a top-level array")
    }
    return value as CoseValue[]
}

/** Decodes a single top-level CBOR value expected to be a map (a COSE header map, or a COSE_Key). */
export function decodeCoseMap(
    bytes: Uint8Array
): Map<number | string, CoseValue> {
    const value = decodeNarrow(bytes)
    if (!(value instanceof Map)) {
        throw new Error("COSE/CBOR: expected a top-level map")
    }
    return value as Map<number | string, CoseValue>
}

/**
 * Decodes a sequence of concatenated top-level canonical values — no
 * length prefixes, each value's own encoding is where the previous one
 * ends. Used for the events socket's header-then-body frames
 * (`spec/wire-api.md#the-events-socket`), mirroring atproto's
 * `subscribeRepos` framing.
 */
export function decodeCoseSequence(bytes: Uint8Array): CoseValue[] {
    const values: CoseValue[] = []
    let remaining = bytes
    while (remaining.length > 0) {
        const [value, rest] = decodeOneCanonical(remaining)
        values.push(value as CoseValue)
        remaining = rest
    }
    return values
}
