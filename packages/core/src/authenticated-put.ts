import { admissionOrUnavailable } from "./admission.js"
import { RESERVED_ENTRY_KEYS } from "./events.js"
import { deriveMessageId } from "./message-id.js"
import type { PairPutDeps } from "./pair-put.js"
import type { ExtensionFields, Locator, MessageRef, PairMailboxKey, PMRStore } from "./storage.js"

/**
 * A pair put whose sender the caller has already authenticated, by the
 * pair-put envelope or by other means the deployment vouches for. From here
 * on it is stored exactly as a verified pair put is: same admission, pool,
 * blocked-sender handling and per-sender quota.
 */
export interface AuthenticatedPut {
    recipientDID: string
    senderDID: PairMailboxKey
    /** CID of the sender declaration the put was authenticated against; becomes `dc`. */
    declarationCID: string
    payload: Uint8Array
    /**
     * Recorded in the sender's anti-replay set where a pair put's nonce goes:
     * a repeat while that record lives is accepted and stores nothing.
     * Opaque; empty throws. Shares the set with pair-put nonces.
     */
    replayKey: Uint8Array
    /**
     * The registration to store into, when the caller already resolved and
     * checked it; the directory is then not consulted, so a concurrent
     * replace cannot redirect the put to a newer registration.
     */
    locator?: Locator
    /** Stored on the entry and emitted beside `sd`/`dc`. A key in `RESERVED_ENTRY_KEYS`, or a number that is not a safe integer, throws. */
    ext?: ExtensionFields
}

export type AuthenticatedPutDeps = Pick<
    PairPutDeps,
    "config" | "directory" | "store" | "bodies" | "admission" | "defer"
>

export type AuthenticatedPutOutcome =
    /**
     * Queued, pooled, a repeat, absorbed for a blocked sender, or dropped by
     * the store (pool exhausted, discard window); deliberately
     * indistinguishable, as for a pair-put sender.
     */
    | { outcome: "accepted" }
    /** The sender's reservation is full. `retryAfter` is absolute, in seconds. */
    | { outcome: "refused"; retryAfter: number }
    /** No `locator` was given and the recipient DID has no registration on this relay. */
    | { outcome: "noRecipient" }
    /** `payload` exceeds `config.limits.messageMaxBytes`; nothing was read or stored. */
    | { outcome: "tooLarge" }

export async function ingestAuthenticatedPut(
    put: AuthenticatedPut,
    deps: AuthenticatedPutDeps,
    nowSeconds: number
): Promise<AuthenticatedPutOutcome> {
    const { config } = deps
    if (put.replayKey.byteLength === 0) {
        throw new Error("ingestAuthenticatedPut: empty replayKey")
    }
    if (put.ext !== undefined) {
        for (const [key, value] of Object.entries(put.ext)) {
            if (RESERVED_ENTRY_KEYS.has(key)) {
                throw new Error(`ingestAuthenticatedPut: reserved extension key "${key}"`)
            }
            // The wire grammar has no floats; an entry carrying one would not decode.
            if (typeof value === "number" && !Number.isSafeInteger(value)) {
                throw new Error(`ingestAuthenticatedPut: extension key "${key}" is not a safe integer`)
            }
        }
    }
    if (put.payload.byteLength > config.limits.messageMaxBytes) return { outcome: "tooLarge" }

    const locator = put.locator ?? (await deps.directory.resolve(put.recipientDID))
    if (locator === null) return { outcome: "noRecipient" }
    const store = deps.store(locator)

    const mailboxKey = put.senderDID
    const messageId = deriveMessageId(put.payload)
    const ref: MessageRef = {
        messageId,
        byteLength: put.payload.byteLength,
        hint: { senderDID: put.senderDID, declarationCID: put.declarationCID },
        ...(put.ext !== undefined ? { ext: put.ext } : {}),
    }
    const storeBody = () =>
        deps.bodies.putBody(
            messageId,
            put.payload,
            nowSeconds + config.limits.messageExpirySeconds
        )

    if (deps.admission) {
        const admission = await admissionOrUnavailable(
            deps.admission,
            mailboxKey,
            put.recipientDID
        )
        const received = await store.receive(
            mailboxKey,
            ref,
            put.replayKey,
            nowSeconds,
            admission
        )
        if (received.outcome === "refused") {
            return { outcome: "refused", retryAfter: received.retryAfter }
        }
        if (received.outcome === "queued" && received.persistBody) {
            deps.defer(
                deliverQueued(
                    store,
                    mailboxKey,
                    ref,
                    put.payload,
                    storeBody,
                    received.moved?.map((moved) => ({
                        ref: moved,
                        // Stored when the entry was pooled.
                        body: () => deps.bodies.getBody(moved.messageId),
                    }))
                )
            )
        } else if (received.outcome === "pooled" && received.persistBody) {
            deps.defer(storeBody())
        }
        return { outcome: "accepted" }
    }

    if (await store.hasMailbox(mailboxKey)) {
        const result = await store.append(mailboxKey, ref, put.replayKey, nowSeconds)
        if (result.outcome === "refused") {
            return { outcome: "refused", retryAfter: result.retryAfter }
        }
        if (result.outcome === "appended" && result.persistBody) {
            // `persistBody` is false when the append was absorbed by the
            // synthetic mailbox; checking it is what keeps "no bytes for a
            // blocked sender" true although this code cannot tell blocked
            // from real.
            deps.defer(deliverQueued(store, mailboxKey, ref, put.payload, storeBody))
        }
        return { outcome: "accepted" }
    }

    // Unprovisioned: the recovery pool. Discard status is checked INSIDE
    // `appendToPool`, not by a separate call this code branches on — a
    // discarded sender's put must cost the same round trip a pooled one
    // does, or the count itself becomes an oracle.
    const pooled = await store.appendToPool(mailboxKey, ref, put.replayKey, nowSeconds)
    if (pooled.outcome === "pooled" && pooled.persistBody) {
        deps.defer(storeBody())
    }
    return { outcome: "accepted" }
}

/**
 * Store the body, then deliver a queued message live and by push. `moved`
 * (pooled entries a yes moved into the mailbox) goes live first, in order,
 * so the device sees the mailbox in queue order; the one push covers them all.
 *
 * Best effort and sequenced after the body write: a failed delivery costs the
 * recipient a reconnect-drain, never a message, since the entry stays queued
 * either way. The body MUST land even if a delivery doesn't, and each
 * delivery's failure is swallowed separately so one cannot prevent another.
 * A duplicate never reaches this: its body already landed.
 */
async function deliverQueued(
    store: PMRStore,
    key: PairMailboxKey,
    ref: MessageRef,
    message: Uint8Array,
    storeBody: () => Promise<void>,
    moved: Array<{ ref: MessageRef; body: () => Promise<Uint8Array | null> }> = []
): Promise<void> {
    await storeBody()
    for (const entry of moved) {
        try {
            const body = await entry.body()
            if (body) await store.deliverLive?.(key, entry.ref, body)
        } catch {}
    }
    try {
        await store.deliverLive?.(key, ref, message)
    } catch {}
    try {
        await store.deliverPush?.(key, ref, message)
    } catch {}
}
