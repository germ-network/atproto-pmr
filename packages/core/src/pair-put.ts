import { decodePairPutEnvelope, verifyPairPut } from "./cose/sign1.js"
import { thumbprintOkpEd25519 } from "./cose/key.js"
import { DeclarationResolution } from "./declaration.js"
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
import { readBodyCapped } from "./util.js"

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
    resolveDeclaration: (senderDID: string) => Promise<DeclarationResolution>
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
 * `POST /pmr/v1/inbox/{did}/messages` — `spec/wire-api.md`, "Delivery —
 * peer-facing" and "The pair-put payload".
 *
 * RESPONSE CONTRACT, read literally from the specification's error table:
 * "peer, pair put: `202`, or `429` + `Retry-After` when their own
 * reservation is full. Nothing else." Applied here as: every
 * claim-dependent or recipient-dependent outcome — bad signature, wrong
 * recipient, unresolvable sender declaration, unknown recipient relay, a
 * discarded sender, a duplicate — answers `202`. `429` is reserved for
 * exactly one case: *this* sender's own provisioned mailbox being full,
 * the one disclosure per-sender reservation makes self-referential.
 *
 * The only distinguishable failure is a structurally malformed request —
 * oversized body, undecodable COSE, non-canonical signature — answered
 * `400` synchronously. Those reveal nothing about the recipient's mailbox,
 * only that the sender's own request is malformed, which the sender
 * already knows.
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
    // malformed envelope and nothing below may answer anything but 202/429.
    let senderKey: PairMailboxKey
    try {
        const bodyBytes = await readBodyCapped(
            request,
            config.limits.messageMaxBytes + config.limits.framingAllowanceBytes
        )
        envelope = decodePairPutEnvelope(bodyBytes)
        if (envelope.payload.payload.byteLength > config.limits.messageMaxBytes) {
            return new Response("Payload exceeds the published maximum", {
                status: 400,
            })
        }
        senderKey = asPairMailboxKey(envelope.payload.senderDID)
    } catch (e) {
        return new Response(`Malformed pair-put envelope: ${String(e)}`, {
            status: 400,
        })
    }

    // --- Everything below is uniform-202 territory. No branch here may
    // return anything but 202 or 429. ---

    // Step 1: sender DID from the SIGNED headers, never from routing.
    // `decodePairPutEnvelope` parsed it out of the protected header map, so
    // there is no routing hint in scope to prefer by construction.
    const declaration = await deps.resolveDeclaration(envelope.payload.senderDID)
    if (!declaration.found) {
        return new Response(null, { status: 202 })
    }

    // Steps 2–4: verify against the RESOLVED key and confirm the signed
    // recipient. `verifyPairPut` takes the key as a parameter and has no
    // access to a resolver, so resolve-before-verify cannot be reordered.
    const outcome = verifyPairPut(
        envelope,
        declaration.anchorKey.x,
        recipientDID
    )
    if (!outcome.valid) {
        return new Response(null, { status: 202 })
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
            anchorKeyThumbprint: hex(
                thumbprintOkpEd25519(declaration.anchorKey)
            ),
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
            deps.defer(storeBody())
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

function hex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}
