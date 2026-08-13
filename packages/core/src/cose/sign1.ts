/**
 * COSE_Sign1 (RFC 9052 §4.2) for the pair-put payload — wire-api.md
 * §The pair-put payload.
 *
 * This module is the security boundary for pair puts. Every check here
 * exists because leaving it out reopens a specific attack the design docs
 * name; see each check's comment for which one.
 */

import { ed25519 } from "@noble/curves/ed25519.js"
import { CoseValue, decodeCoseArray, decodeCoseMap, encodeCose } from "./cbor"

// COSE Header Parameters (RFC 9052 §3.1). `alg` and `kid` are registered;
// the sender/recipient DID, type+version marker, and anti-replay nonce have
// no registered label yet (wire-api.md "Open items": "COSE header labels —
// registered vs private-use"). Stage-3 decision: private-use now, chosen
// from a range clearly outside the standard's allocated space so a future
// registration cannot collide silently. Not wire-compatible with any other
// implementation's guess at these same labels until this is settled — that
// is the acknowledged cost of shipping before registration.
const LABEL_ALG = 1
const LABEL_KID = 4
const LABEL_SENDER_DID = -60001
const LABEL_RECIPIENT_DID = -60002
const LABEL_TYPE_VERSION = -60003
const LABEL_NONCE = -60004

// COSE Algorithms (RFC 9053 §7.4). EdDSA — the algorithm the sender's
// *declared* key type implies, pinned by the verifier and never trusted
// from the message (wire-api.md: "pinned by the verifier to the algorithm
// the sender's declared key type implies, never trusted from the message").
const ALG_EDDSA = -8

/** Domain separation: an anchor signature over a v1 pair put must not verify as anything else. */
export const PAIR_PUT_TYPE_VERSION = "germ-pmr:pair-put:v1"

export interface PairPutPayload {
    senderDID: string
    recipientDID: string
    /** RFC 9679 thumbprint of the sender's anchor key. Diagnostic only — see `verifyPairPut`. */
    kid: Uint8Array
    nonce: Uint8Array
    /** The sealed message, opaque at this layer. */
    payload: Uint8Array
}

/**
 * Ed25519 group order L, for signature-canonicality rejection (RFC 8032
 * §5.1.7). `S` (the low half of the 64-byte signature) MUST satisfy
 * `0 <= S < L`, or the signature is malleable — the same message and key
 * admit multiple valid signature encodings, which would let a malleated
 * duplicate slip content-address-based dedup (wire-api.md §Malleability:
 * "content-addressing the signed envelope would let a malleated copy slip
 * dedup, which is replay by another door").
 *
 * Enforced as a standalone gate BEFORE `@noble/curves` is ever called, not
 * as trust in that library's default behavior — see cose/README notes in
 * the implementation plan for why: its documented example and its actual
 * default-argument resolution disagree with each other.
 */
// Decimal form, not a hand-split hex literal: hex-digit-count transcription
// is exactly the error class this check exists to catch elsewhere, so it
// isn't the form to trust for the constant itself. This is the textbook
// definition, and matches @noble/curves' own inlined comment for the same
// constant (`ed25519.js`: "N = 2n**252n + 27742317777372353535851937790883648493n").
const CURVE_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n

function isCanonicalS(signature: Uint8Array): boolean {
    if (signature.byteLength !== 64) return false
    const s = signature.subarray(32, 64)
    let value = 0n
    for (let i = 31; i >= 0; i--) {
        value = (value << 8n) | BigInt(s[i])
    }
    return value < CURVE_ORDER
}

/**
 * The `Sig_structure` this payload signs over (RFC 9052 §4.4), for a
 * COSE_Sign1 with no external AAD and a detached-from-nothing payload (the
 * payload is carried in the structure itself, per the wire format below).
 */
function sigStructure(protectedHeaderBytes: Uint8Array, payload: Uint8Array): Uint8Array {
    return encodeCose([
        "Signature1",
        protectedHeaderBytes,
        new Uint8Array(0), // external_aad — none
        payload,
    ])
}

/**
 * Decodes and structurally validates a COSE_Sign1 CBOR array into its parts,
 * WITHOUT verifying the signature — that is `verifyPairPut`'s job, and it
 * needs the resolved anchor key as an input this function does not have.
 *
 * This function's failures are address-independent, synchronous, and safe
 * to report as real 400s (wire-api.md's response-code table): malformed
 * structure reveals nothing about the recipient's mailbox.
 */
export function decodePairPutEnvelope(bytes: Uint8Array): {
    protectedHeaderBytes: Uint8Array
    payload: PairPutPayload
    signature: Uint8Array
} {
    const array = decodeCoseArray(bytes)
    if (array.length !== 4) {
        throw new Error("COSE_Sign1: expected a 4-element array")
    }
    const [protectedHeaderBytes, unprotected, sealedPayload, signature] = array

    if (!(protectedHeaderBytes instanceof Uint8Array)) {
        throw new Error("COSE_Sign1: protected header must be a bstr-wrapped map")
    }
    if (!(unprotected instanceof Map) || unprotected.size !== 0) {
        // Every header this profile defines is signed (wire-api.md: "all
        // covered by the signature and all readable by the relay without
        // touching the body"). An unprotected header carrying any of them
        // would be an unsigned copy an attacker could substitute — reject
        // rather than silently ignore.
        throw new Error("COSE_Sign1: unprotected header must be empty")
    }
    if (!(sealedPayload instanceof Uint8Array)) {
        throw new Error("COSE_Sign1: payload must be a byte string")
    }
    if (!(signature instanceof Uint8Array)) {
        throw new Error("COSE_Sign1: signature must be a byte string")
    }

    // Non-canonical signature: rejected here, structurally, before any
    // verification is attempted — RFC 8032 §5.1.7.
    if (!isCanonicalS(signature)) {
        throw new Error("COSE_Sign1: signature is not canonical (S >= L)")
    }

    const headerMap = decodeCoseMap(protectedHeaderBytes)

    const alg = headerMap.get(LABEL_ALG)
    if (alg !== ALG_EDDSA) {
        throw new Error(`COSE_Sign1: expected alg=EdDSA(-8), got ${String(alg)}`)
    }

    const kid = headerMap.get(LABEL_KID)
    if (!(kid instanceof Uint8Array)) {
        throw new Error("COSE_Sign1: kid must be a byte string")
    }

    const senderDID = headerMap.get(LABEL_SENDER_DID)
    if (typeof senderDID !== "string" || senderDID.length === 0) {
        throw new Error("COSE_Sign1: missing sender DID header")
    }

    const recipientDID = headerMap.get(LABEL_RECIPIENT_DID)
    if (typeof recipientDID !== "string" || recipientDID.length === 0) {
        throw new Error("COSE_Sign1: missing recipient DID header")
    }

    const typeVersion = headerMap.get(LABEL_TYPE_VERSION)
    if (typeVersion !== PAIR_PUT_TYPE_VERSION) {
        // Domain separation, both dimensions at once: a signature over any
        // other frame type, or over a different pair-put wire version, must
        // not verify as this one (wire-api.md: "an anchor signature over a
        // v1 pair put must not verify as a registration, a session frame,
        // or a v2 pair put").
        throw new Error("COSE_Sign1: wrong type/version marker")
    }

    const nonce = headerMap.get(LABEL_NONCE)
    if (!(nonce instanceof Uint8Array) || nonce.byteLength === 0) {
        throw new Error("COSE_Sign1: missing anti-replay nonce header")
    }

    return {
        protectedHeaderBytes,
        payload: {
            senderDID,
            recipientDID,
            kid,
            nonce,
            payload: sealedPayload,
        },
        signature,
    }
}

export type VerifyOutcome =
    | { valid: true }
    | { valid: false; reason: string }

/**
 * The verification algorithm (wire-api.md §The pair-put payload). Four
 * steps, none optional, and their ORDER is what this function's signature
 * enforces structurally: it takes the resolved anchor key as a parameter and
 * has no access to a declaration resolver, so step 2 (resolve) cannot be
 * skipped or reordered after step 3 (verify) by any caller — there is
 * nothing else to verify against.
 *
 * `kid` (the header's key thumbprint) participates in NONE of this trust.
 * It is read nowhere in this function's verification logic — only
 * `resolvedAnchorKey`, which the caller obtained by resolving the SIGNED
 * sender DID's declaration, is ever verified against. A verifier that
 * checked the signature against a key taken from the message (`kid`, or
 * anything else in the envelope) would have reproduced the exact gap this
 * algorithm exists to close: an attacker can self-sign with their own key
 * and claim any sender DID they like in the header, since the header is
 * just bytes they also control. The binding that matters — DID to key —
 * comes only from the declaration the caller resolved.
 */
export function verifyPairPut(
    envelope: ReturnType<typeof decodePairPutEnvelope>,
    resolvedAnchorKey: Uint8Array,
    thisRecipientDID: string
): VerifyOutcome {
    // Step 3, checked FIRST — matches wire-api.md's literal listed order
    // (verify-signature before recipient-match). Verify against the
    // RESOLVED key, never any key or thumbprint carried in the message.
    const message = sigStructure(envelope.protectedHeaderBytes, envelope.payload.payload)
    const ok = ed25519.verify(envelope.signature, message, resolvedAnchorKey, {
        zip215: false,
    })
    if (!ok) {
        return { valid: false, reason: "signature verification failed" }
    }

    // Step 4 (recipient half): binds this message to its destination, so a
    // put captured at one PMR cannot replay at another and verify (wire-api.md
    // "Why the recipient DID must be signed" — the RFC 9421 request signature
    // that would otherwise carry this dies at the relay; only the payload's
    // own signature is durable).
    if (envelope.payload.recipientDID !== thisRecipientDID) {
        return { valid: false, reason: "recipient DID mismatch" }
    }

    return { valid: true }
    // Step 4 (nonce half — "unseen") and step 1 (sender DID taken from the
    // signed headers, never routing) are enforced by the caller: step 1
    // because this function never receives a routing hint to prefer by
    // construction, and the nonce check because it must be atomic with the
    // mailbox append (see the DO adapter) — folding it in here would let two
    // concurrent replays both pass this function before either records the
    // nonce.
}

export function encodePairPutEnvelope(
    payload: PairPutPayload,
    sign: (message: Uint8Array) => Uint8Array
): Uint8Array {
    const headerMap = new Map<number | string, CoseValue>([
        [LABEL_ALG, ALG_EDDSA],
        [LABEL_KID, payload.kid],
        [LABEL_SENDER_DID, payload.senderDID],
        [LABEL_RECIPIENT_DID, payload.recipientDID],
        [LABEL_TYPE_VERSION, PAIR_PUT_TYPE_VERSION],
        [LABEL_NONCE, payload.nonce],
    ])
    const protectedHeaderBytes = encodeCose(headerMap)
    const message = sigStructure(protectedHeaderBytes, payload.payload)
    const signature = sign(message)

    return encodeCose([protectedHeaderBytes, new Map(), payload.payload, signature])
}
