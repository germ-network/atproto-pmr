import { decodePairPutEnvelope, verifyPairPut } from "./cose/sign1.js"
import { SenderDeclarationResolution } from "./declaration.js"
import { asPairMailboxKey } from "./mailbox-key.js"
import { deriveMessageId } from "./message-id.js"
import { PMRConfig } from "./config.js"
import {
    BodyStore,
    Directory,
    Locator,
    PairMailboxKey,
    PMRStore,
} from "./storage.js"
import { BodyTooLargeError, readBodyCapped } from "./util.js"

/**
 * Everything the pair-put handler needs, injected rather than reached for.
 *
 * This is what keeps this package free of any platform: no `fetch` global,
 * no Workers `ExecutionContext`, no bindings. A Cloudflare deployment wires
 * these to Durable Objects and KV; a relational one wires them to its own
 * adapters, and neither has to modify this file.
 */
export interface PairPutDeps {
    config: PMRConfig
    directory: Directory
    /** Reach one relay's store from its locator. */
    store: (locator: Locator) => PMRStore
    bodies: BodyStore
    /**
     * DID → declaration → anchor key. Injected because it makes a network
     * call, which a test must be able to replace and a platform may want to
     * route through its own fetch.
     */
    resolveDeclaration: (senderDID: string) => Promise<SenderDeclarationResolution>
    /**
     * Run work after the response has been produced. On Workers this is
     * `ctx.waitUntil`; elsewhere it can be a plain fire-and-forget.
     *
     * Load-bearing rather than an optimization: body writes and delivery
     * MUST sit after the response so that the extra work a real mailbox
     * does relative to a synthetic one is off the response path entirely.
     */
    defer: (work: Promise<unknown>) => void
}

/**
 * `Retry-After` on the `409` for a put the relay cannot verify under the
 * sender's current declaration. The monitor ingests a new declaration within
 * about this long of its commit, and a KV-backed snapshot or signing-key
 * cache takes about as long to propagate.
 */
export const DECLARATION_RETRY_AFTER_SECONDS = 60

/**
 * `POST /pmr/v1/inbox/{did}/messages` — `spec/wire-api.md`, "Delivery —
 * peer-facing" and "The pair-put payload".
 *
 * RESPONSE CONTRACT: the outcome depends on the request's own bytes and on
 * the relay's view of the *sender*, plus this sender's own mailbox for `429`.
 *
 *  - `400` / `413`: decided on the request's own bytes and the advertised
 *    limits, before any lookup.
 *  - `409` + `Retry-After`: the relay has no verifiable declaration for the
 *    sender (none held, stale, or unverifiable), or the signature fails under
 *    the one it has. Nothing is stored. The two causes are deliberately not
 *    distinguished: a sender who has just rotated its key sees the same
 *    answer as one whose declaration the relay has not yet ingested, and
 *    both normally clear by waiting; one that persists is the sender's to surface. Decided after sender resolution and before any
 *    recipient lookup, so it reveals nothing about the recipient. What it
 *    does reveal — whether the relay's monitor holds the sender's
 *    declaration — is public already (the monitor serves it per DID).
 *  - `429` + `Retry-After`: this sender's own provisioned mailbox is full,
 *    the one recipient-side fact per-sender reservation makes
 *    self-referential.
 *  - `202`: everything else — a validly signed put whether or not the
 *    recipient exists, names another recipient, is blocked, discarded or a
 *    duplicate. `5xx` is reserved for genuine relay faults.
 *
 * `413` is kept distinct from `400` because the two are differently
 * actionable: `400` says the sender's encoder is wrong, `413` says only
 * that this message is too big and a smaller one would be accepted.
 */
export async function handlePairPut(
    request: Request,
    recipientDID: string,
    deps: PairPutDeps,
    nowSeconds: number
): Promise<Response> {
    const { config } = deps

    // --- Address-independent and synchronous. Malformed input is real
    // client error and safe to report distinctly. ---
    let envelope: ReturnType<typeof decodePairPutEnvelope>
    // The mailbox key is the sender's DID, from the SIGNED headers — the
    // same value verification runs against, never a routing hint. Narrowed
    // here, in request-bytes-only territory, because a non-DID sender is a
    // malformed envelope and nothing below may answer 400.
    let senderKey: PairMailboxKey
    try {
        const bodyBytes = await readBodyCapped(
            request,
            config.limits.messageMaxBytes + config.limits.framingAllowanceBytes
        )
        envelope = decodePairPutEnvelope(bodyBytes)
        if (envelope.payload.payload.byteLength > config.limits.messageMaxBytes) {
            return new Response("Payload exceeds the advertised maximum", {
                status: 413,
            })
        }
        senderKey = asPairMailboxKey(envelope.payload.senderDID)
    } catch (e) {
        if (e instanceof BodyTooLargeError) {
            return new Response("Body exceeds the advertised maximum", {
                status: 413,
            })
        }
        return new Response(`Malformed pair-put envelope: ${String(e)}`, {
            status: 400,
        })
    }

    // --- Past this point only 409 (sender state), 202 and 429 are possible. ---

    // Step 1: sender DID from the SIGNED headers, never from routing.
    // `decodePairPutEnvelope` parsed it out of the protected header map, so
    // there is no routing hint in scope to prefer by construction.
    const declaration = await deps.resolveDeclaration(envelope.payload.senderDID)
    if (!declaration.found) return declarationUnverifiable()

    // Steps 2–4: verify against the RESOLVED key and confirm the signed
    // recipient. `verifyPairPut` takes the key as a parameter and has no
    // access to a resolver, so resolve-before-verify cannot be reordered.
    const outcome = verifyPairPut(
        envelope,
        declaration.anchorKey.x,
        recipientDID
    )
    if (!outcome.valid) {
        // A wrong recipient is not declaration state: waiting would not
        // help, so it stays the uniform 202.
        return outcome.code === "signature"
            ? declarationUnverifiable()
            : new Response(null, { status: 202 })
    }

    const locator = await deps.directory.resolve(recipientDID)
    if (locator === null) {
        // Unknown recipient relay. The RESPONSE is the same `202` a
        // registered recipient's mailbox eventually produces.
        //
        // KNOWN, ACCEPTED GAP: this returns before touching any per-relay
        // store, while a registered recipient costs at least one round
        // trip — a timing difference that could reveal registration status
        // to an attacker who can measure it, even though the content never
        // does. Closing it means doing comparable work against a DID with
        // no store to touch, and the obvious approach — instantiating a
        // store for every unregistered DID an unauthenticated request names
        // — is its own resource-exhaustion surface. Flagged in
        // `spec/trust-model.md` rather than papered over.
        return new Response(null, { status: 202 })
    }
    const store = deps.store(locator)

    const mailboxKey = senderKey
    const messageId = deriveMessageId(envelope.payload.payload)
    const ref = {
        messageId,
        byteLength: envelope.payload.payload.byteLength,
        hint: {
            senderDID: envelope.payload.senderDID,
            declarationCID: declaration.declarationCID,
        },
    }

    const storeBody = () =>
        deps.bodies.putBody(
            messageId,
            envelope.payload.payload,
            nowSeconds + config.limits.messageExpirySeconds
        )

    if (await store.hasMailbox(mailboxKey)) {
        const result = await store.append(
            mailboxKey,
            ref,
            envelope.payload.nonce,
            nowSeconds
        )
        if (result.outcome === "refused") {
            return new Response(null, {
                status: 429,
                headers: {
                    "Retry-After": String(
                        Math.max(0, result.retryAfter - nowSeconds)
                    ),
                },
            })
        }
        if (result.outcome === "appended" && result.persistBody) {
            // `persistBody` is false when the append was absorbed by the
            // synthetic mailbox. Checking it — rather than storing
            // unconditionally — is what keeps "no bytes for a blocked
            // sender" true even though this code cannot tell blocked from
            // real. `duplicate` never re-stores; the body already landed.
            deps.defer(
                (async () => {
                    await storeBody()
                    // Best effort, and sequenced after the body write: a
                    // failed push costs the recipient a reconnect-drain,
                    // never a message, since the entry stays queued either
                    // way. Swallowing the error here (not on storeBody)
                    // keeps that asymmetry — the body MUST land even if the
                    // live push doesn't.
                    try {
                        await store.deliverLive?.(
                            mailboxKey,
                            ref,
                            envelope.payload.payload
                        )
                    } catch {}
                    // Same asymmetry as deliverLive: a failed push costs
                    // nothing beyond itself, so its error is swallowed
                    // separately rather than let it prevent deliverLive
                    // from running or vice versa.
                    try {
                        await store.deliverPush?.(
                            mailboxKey,
                            ref,
                            envelope.payload.payload
                        )
                    } catch {}
                })()
            )
        }
        return new Response(null, { status: 202 })
    }

    // Unprovisioned: the recovery pool. Discard status is checked INSIDE
    // `appendToPool`, not by a separate call this code branches on — a
    // discarded sender's put must cost the same round trip a pooled one
    // does, or the count itself becomes an oracle.
    const pooled = await store.appendToPool(
        mailboxKey,
        ref,
        envelope.payload.nonce,
        nowSeconds
    )
    if (pooled.outcome === "pooled" && pooled.persistBody) {
        deps.defer(storeBody())
    }
    return new Response(null, { status: 202 })
}

function declarationUnverifiable(): Response {
    return new Response(null, {
        status: 409,
        headers: { "Retry-After": String(DECLARATION_RETRY_AFTER_SECONDS) },
    })
}
