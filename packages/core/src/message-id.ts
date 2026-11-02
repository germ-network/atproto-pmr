import { sha256 } from "@noble/hashes/sha2.js"
import type { Locator, MailboxKey, MessageId } from "./storage.js"

/**
 * Message identity and content addresses.
 *
 * Uses `@noble/hashes` rather than WebCrypto, deliberately: it keeps this
 * package free of any platform's crypto global, and it lets this be
 * synchronous, which matters because it sits on the pair-put hot path.
 */

/**
 * `TypedDigest` wire format: one algorithm-identifier byte followed by the
 * digest bytes — algorithm-prefixed and self-describing, not multihash and
 * not a CID (`spec/wire-api.md`, "Content addressing and idempotency").
 *
 * SHA-256 is the only algorithm currently assigned. The identifier
 * assignments are listed as not-yet-specified; this value matches the
 * format's existing definition.
 */
const DIGEST_ALG_SHA256 = 1

function hex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * The mailbox a message is stored in: one registration's store, one key in it.
 * The locator is fixed for the registration's lifetime; a replaced
 * registration has a new locator and no ref carries over.
 */
export interface MessageDestination {
    locator: Locator
    key: MailboxKey
}

/**
 * `TypedDigest` of `bytes`: a content address, computable by anyone holding
 * the bytes. Never a message id — two destinations holding the same bytes
 * would share it, and the body store's effects would cross between them.
 */
export function typedDigest(bytes: Uint8Array): string {
    const digest = sha256(bytes)
    const out = new Uint8Array(1 + digest.length)
    out[0] = DIGEST_ALG_SHA256
    out.set(digest, 1)
    return hex(out)
}

const ID_DOMAIN = new TextEncoder().encode("atproto-pmr/message-id/v1\0")

function lengthPrefixed(text: string): Uint8Array {
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > 0xffff) throw new Error("messageIdFor: destination field exceeds 65535 bytes")
    const out = new Uint8Array(2 + bytes.length)
    out[0] = bytes.length >> 8
    out[1] = bytes.length & 0xff
    out.set(bytes, 2)
    return out
}

/**
 * The id of `payload` stored at `destination` (`spec/wire-api.md`, "Content
 * addressing and idempotency"). It binds the destination as well as the
 * bytes, so two refs share an id only when they are in the same mailbox, and
 * no operation on one mailbox can reach a body held for another. A retried
 * put to the same destination gets the same id.
 *
 * The hash covers the SEALED PAYLOAD — never the signature envelope.
 * Ed25519 signatures are malleable, so hashing the envelope would let a
 * malleated copy slip past dedup, which is replay by another door
 * (`spec/wire-api.md`, "Malleability"). Rejecting non-canonical signatures
 * is the other requirement there; either alone is insufficient.
 */
export function messageIdFor(destination: MessageDestination, payload: Uint8Array): MessageId {
    const parts = [
        ID_DOMAIN,
        lengthPrefixed(destination.locator),
        lengthPrefixed(destination.key),
        sha256(payload),
    ]
    const preimage = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) {
        preimage.set(part, offset)
        offset += part.length
    }
    return typedDigest(preimage) as MessageId
}
