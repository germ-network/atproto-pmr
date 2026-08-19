import { encodeCose, type CoseValue } from "../cose/cbor.js"
import { messageEntryFields } from "../events.js"
import type { MailboxKey, MessageRef } from "../storage.js"
import { SEAL_OVERHEAD_BYTES } from "./seal.js"

/**
 * The plaintext sealed inside a Web Push payload — `spec/wire-api.md`,
 * "The sealed payload". One place decides all three shapes, so a future
 * change to any of them has one obvious place to land.
 *
 * `t: "p"` and `t: "d"` are always exactly `{t}` and nothing else,
 * permanently, not merely because nothing produces richer versions of them
 * yet:
 *
 *   - `t: "p"` (pool threshold crossed): per-arrival content would be
 *     exactly the harassment vector pool adjudication's batching exists to
 *     prevent — same reasoning as the events socket's `#pool` frame.
 *   - `t: "d"` (the device's own watched declaration changed): a
 *     key-transparency monitor's whole purpose is catching a hostile or
 *     buggy source that lies by omission or serves something stale.
 *     Bundling "here's what changed" into the push would let a
 *     compromised deliverer assert a declaration directly to the device,
 *     bypassing the fetch-and-compare-across-monitors step the system
 *     exists to force. This holds even though the declaration record
 *     itself is a signed, self-authenticating commit — the risk here is
 *     withholding/staleness, not forgery.
 *
 * `t: "m"` (a message arrived) is the one case with a size decision: the
 * message is included when the sealed total still fits the push service's
 * ceiling, and degrades to a pointer-only form when it doesn't. This is a
 * size decision, not a disclosure one — the push service only ever sees
 * opaque ciphertext either way, and the recipient's device is already
 * entitled to this exact content over the socket or REST catch-up.
 */

export function buildPoolPushPayload(): Uint8Array {
    return encodeCose(new Map<string, CoseValue>([["t", "p"]]))
}

export function buildDeclarationPushPayload(): Uint8Array {
    return encodeCose(new Map<string, CoseValue>([["t", "d"]]))
}

export interface BuildMessagePushPayloadOptions {
    key: MailboxKey
    ref: MessageRef
    message: Uint8Array
    /** The push service's payload ceiling, in bytes — the same value passed to `sealPushPayload`. */
    maxSealedBytes: number
}

/**
 * Builds the best-fitting plaintext for a message arrival: the full form
 * (reusing `messageEntryFields`'s exact field vocabulary — the same one
 * `#delivery` and REST catch-up already use, so a push carries a
 * byte-identical shape to every other delivery path) when it fits within
 * `maxSealedBytes` once sealed, or a pointer-only form when it doesn't.
 *
 * Compares against `SEAL_OVERHEAD_BYTES` directly rather than attempting a
 * seal and catching `PushPayloadTooLargeError`, so the fallback decision
 * costs a byte-length comparison, not a wasted encryption.
 */
export function buildMessagePushPayload(
    opts: BuildMessagePushPayloadOptions
): Uint8Array {
    const full = new Map<string, CoseValue>([
        ["t", "m"],
        ...messageEntryFields(opts.key, opts.ref, opts.message),
    ])
    const fullBytes = encodeCose(full)
    if (fullBytes.byteLength + SEAL_OVERHEAD_BYTES <= opts.maxSealedBytes) {
        return fullBytes
    }

    const pointerOnly = new Map<string, CoseValue>([
        ["t", "m"],
        ["k", opts.key],
        ["id", opts.ref.messageId],
    ])
    return encodeCose(pointerOnly)
}
