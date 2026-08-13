import type {
    GrantMailboxKey,
    MailboxKey,
    PairMailboxKey,
} from "./storage.js"

/**
 * The one inbox path carries both mailbox kinds, told apart by prefix —
 * `spec/wire-api.md`, "Delivery — peer-facing".
 *
 * **The prefixes are not symmetric, and the asymmetry is the point.** A DID
 * already begins with `did:`; that is what the DID scheme is. So a pair key
 * IS the DID, carried verbatim, with nothing added and nothing to strip. A
 * grant address is opaque bytes with no self-describing prefix of its own,
 * so it gets one.
 *
 * Adding `did:` to a DID would produce `did:did:plc:alice`, and stripping a
 * prefix off the did arm would hand a truncated DID to routing.
 *
 * `did:grant:...` is not ambiguous: it starts with `did:`, so it is a DID
 * whose method is named `grant`, and it routes as a pair key.
 */

const DID_PREFIX = "did:"
const GRANT_PREFIX = "grant:"

export type ParsedMailboxKey =
    | { kind: "did"; did: string }
    | { kind: "grant"; address: string }

/**
 * Throws on a key matching neither prefix. Callers on the put path MUST
 * treat that as a request-shape failure decidable from the request bytes
 * alone — never as "no such mailbox", which would answer a question the
 * closure exception (`spec/wire-api.md`) says a put never answers.
 */
export function parseMailboxKey(raw: string): ParsedMailboxKey {
    if (raw.startsWith(DID_PREFIX)) {
        // Verbatim: the key is the DID.
        return { kind: "did", did: raw }
    }
    if (raw.startsWith(GRANT_PREFIX)) {
        return { kind: "grant", address: raw.slice(GRANT_PREFIX.length) }
    }
    throw new Error(
        `mailbox key must begin with "${DID_PREFIX}" or "${GRANT_PREFIX}"`
    )
}

/** The routing key for a grant address. The inverse of the grant arm above. */
export function grantMailboxKey(address: string): GrantMailboxKey {
    return `${GRANT_PREFIX}${address}`
}

/** True for a DID — i.e. for something usable as a pair mailbox key. */
export function isPairMailboxKey(raw: string): raw is PairMailboxKey {
    return raw.startsWith(DID_PREFIX)
}

/**
 * Narrow a DID arriving from the wire — a request path, or a DID list in an
 * owner's request body — to a pair mailbox key.
 *
 * Throws rather than returning null: every caller reached this with
 * something it already believes is a DID, so a failure here is a malformed
 * request, decidable from the request bytes alone and therefore safe to
 * refuse. See `parseMailboxKey` on why that stays clear of closure.
 */
export function asPairMailboxKey(raw: string): PairMailboxKey {
    if (!isPairMailboxKey(raw)) {
        throw new Error(`not a DID: ${JSON.stringify(raw)}`)
    }
    return raw
}

/** Narrow a mailbox key of either kind arriving from the wire. */
export function asMailboxKey(raw: string): MailboxKey {
    parseMailboxKey(raw)
    return raw as MailboxKey
}
