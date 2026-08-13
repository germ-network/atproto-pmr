import { decodeCoseSequence, encodeCose, type CoseValue } from "./cose/cbor.js"
import type { GrantLifecycle } from "./config.js"
import type { BodyStore, MessageRef, PMRStore } from "./storage.js"

/**
 * `GET /pmr/v1/events` — `spec/wire-api.md`, "The events socket".
 *
 * Frames are two concatenated top-level canonical CBOR values — a header
 * immediately followed by a body, no length prefix — mirroring atproto's
 * `subscribeRepos` framing rather than inventing one:
 *
 *     header = { "op": 1, "t": "#<type>" }
 *     body   = { ... type-specific fields ... }
 *
 * `op: 1` is a normal frame; nothing here emits `op: -1` (an error frame)
 * yet, but the header shape reserves it, matching atproto's convention.
 *
 * **This is deliberately NOT a durable, resumable event log with a
 * sequence cursor.** Unlike atproto's ephemeral commit stream, a message
 * here stays durable in its mailbox queue until acked — reconnecting and
 * draining `openMailboxes` again IS the resume mechanism, and it recovers
 * everything an event-log cursor would, without one. What a cursor-based
 * log would add is detecting drops or reordering *within* one live
 * connection, which is a diagnostic concern, not a delivery-loss one.
 */

const OP_NORMAL = 1

function encodeFrame(type: string, body: Map<string, CoseValue>): Uint8Array {
    const header = encodeCose(
        new Map<string, CoseValue>([
            ["op", OP_NORMAL],
            ["t", `#${type}`],
        ])
    )
    const bodyBytes = encodeCose(body)
    const out = new Uint8Array(header.length + bodyBytes.length)
    out.set(header, 0)
    out.set(bodyBytes, header.length)
    return out
}

export interface DecodedFrame {
    type: string
    body: Map<string, CoseValue>
}

/** Throws on anything structurally malformed — callers decide what to do with that. */
export function decodeFrame(bytes: Uint8Array): DecodedFrame {
    const values = decodeCoseSequence(bytes)
    if (values.length !== 2) {
        throw new Error("events: expected exactly a header and a body")
    }
    const [header, body] = values
    if (!(header instanceof Map) || !(body instanceof Map)) {
        throw new Error("events: header and body must both be maps")
    }
    const op = header.get("op")
    const t = header.get("t")
    if (op !== OP_NORMAL || typeof t !== "string" || !t.startsWith("#")) {
        throw new Error("events: malformed frame header")
    }
    return { type: t.slice(1), body: body as Map<string, CoseValue> }
}

/**
 * A queued message, pair or grant mailbox alike — the socket does not
 * distinguish them, matching `openMailboxes`. `sd`/`kt` (the relay's
 * verification hint) are present only when the ref carries one, which pair
 * mailboxes do and grant mailboxes never do.
 */
export function encodeDeliveryFrame(
    mailboxKey: string,
    ref: MessageRef,
    message: Uint8Array
): Uint8Array {
    const entries: [string, CoseValue][] = [
        ["k", mailboxKey],
        ["id", ref.messageId],
        ["m", message],
    ]
    if (ref.hint !== undefined) {
        entries.push(["sd", ref.hint.senderDID])
        entries.push(["kt", ref.hint.anchorKeyThumbprint])
    }
    return encodeFrame("delivery", new Map(entries))
}

/**
 * The wake with no list — `wire-api.md`'s own framing for why: naming
 * pooled senders here would be a per-arrival push identifying who, exactly
 * what pool adjudication's batching exists to prevent. The device already
 * has `GET /pmr/v1/pool` to fetch one.
 */
export function encodePoolFrame(): Uint8Array {
    return encodeFrame("pool", new Map())
}

/**
 * What this deployment currently serves **for this registration**.
 *
 * Per-registration rather than deployment-wide because a `grant` drain
 * ends when *that* registration's last grant expires, so two clients of
 * the same deployment can legitimately see different states at once.
 */
export interface EffectiveCapabilities {
    pairMailbox: "active" | "absent"
    grant: GrantLifecycle
    watch: "active" | "absent"
    observation: "active" | "absent"
}

export function encodeCapabilitiesFrame(c: EffectiveCapabilities): Uint8Array {
    return encodeFrame(
        "capabilities",
        new Map<string, CoseValue>([
            ["pm", c.pairMailbox],
            ["gr", c.grant],
            ["wt", c.watch],
            ["ob", c.observation],
        ])
    )
}

/**
 * Unconditional "your connect-time backlog is finished" — sent whether or
 * not `#pool` was.
 *
 * NOT to be confused with the `grant` capability's `draining` state, which
 * says the deployment has stopped vending grants
 * (`spec/wire-api.md`, "Retirement"). Both words appear on this socket and
 * they mean unrelated things; this one is about a queue, that one about a
 * capability being retired.
 */
export function encodeCaughtUpFrame(): Uint8Array {
    return encodeFrame("caughtUp", new Map())
}

export interface AckPayload {
    key: string
    messageId: string
}

export function decodeAckFrame(bytes: Uint8Array): AckPayload {
    const frame = decodeFrame(bytes)
    if (frame.type !== "ack") {
        throw new Error(`events: expected an ack frame, got "${frame.type}"`)
    }
    const key = frame.body.get("k")
    const id = frame.body.get("id")
    if (typeof key !== "string" || typeof id !== "string") {
        throw new Error("events: malformed ack frame")
    }
    return { key, messageId: id }
}

export interface EventsDeps {
    store: PMRStore
    bodies: BodyStore
}

/** Implementation-defined, like every other limit in this package. */
const DEFAULT_DRAIN_PAGE_SIZE = 50

/**
 * Reconnect-drain: `#capabilities` first, then every pending message
 * across every mailbox oldest page first, then the pool notice (only if
 * there is one), then `#caughtUp` — always last, always sent, so the
 * client has an unconditional signal that backlog is over even when the
 * pool is empty.
 *
 * `#capabilities` leads because it frames how to read everything after it:
 * a client that does not yet know the deployment serves no pair mailboxes
 * cannot tell "none queued" from "not offered".
 *
 * `capabilities` is a parameter rather than part of `EventsDeps` because
 * the other consumer of those deps — the ack path — has no use for it, and
 * the deployment computes it per registration anyway.
 *
 * `send` is injected rather than this taking a WebSocket directly: nothing
 * here is Cloudflare-specific, and hibernation's own accept/attach
 * mechanics belong in the deployment layer.
 */
export async function drainBacklog(
    deps: EventsDeps,
    capabilities: EffectiveCapabilities,
    send: (frame: Uint8Array) => void,
    pageSize: number = DEFAULT_DRAIN_PAGE_SIZE
): Promise<void> {
    send(encodeCapabilitiesFrame(capabilities))

    let cursor: string | null = null
    do {
        const page = await deps.store.openMailboxes(cursor, pageSize)
        for (const entry of page.entries) {
            for (const ref of entry.messages) {
                const body = await deps.bodies.getBody(ref.messageId)
                // Missing (expired, or racing retention) — skip rather than
                // fail the whole drain. The ack path is idempotent either
                // way, and there is nothing left to deliver.
                if (body === null) continue
                send(encodeDeliveryFrame(entry.key, ref, body))
            }
        }
        cursor = page.nextCursor
    } while (cursor !== null)

    const pool = await deps.store.poolSenders()
    if (pool.length > 0) {
        send(encodePoolFrame())
    }
    send(encodeCaughtUpFrame())
}

/** Acks are idempotent — `remove` already succeeds on an unknown record. */
export async function handleAckFrame(
    deps: EventsDeps,
    frameBytes: Uint8Array
): Promise<void> {
    const ack = decodeAckFrame(frameBytes)
    await deps.store.remove(ack.key, ack.messageId)
}
