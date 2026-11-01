import { admissionOrUnavailable, type AdmissionSource } from "./admission.js"
import { deriveMessageId } from "./message-id.js"
import { decodePairPutEnvelope, verifyPairPut } from "./cose/sign1.js"
import { SenderDeclarationResolution } from "./declaration.js"
import { asPairMailboxKey } from "./mailbox-key.js"
import { PMRConfig } from "./config.js"
import {
    BodyStore,
    Directory,
    Locator,
    MessageRef,
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
     * DID → independently verified declaration CAR → anchor key and CID.
     * Injected because the monitor read makes a network call, which a test
     * must be able to replace and a platform may route through its own fetch.
     */
    resolveDeclaration: (senderDID: string) => Promise<SenderDeclarationResolution>
    /**
     * Whether the recipient accepts this sender, read once per put that
     * reaches a registered store and before anything is stored. Omitted, the
     * relay adjudicates nothing: unprovisioned senders pool without a verdict.
     */
    admission?: AdmissionSource
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
 *    sender (none held, out of date, or unverifiable), or the signature fails under
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
        // An unknown recipient answers the same 202 as a registered one.
        return new Response(null, { status: 202 })
    }
    const store = deps.store(locator)
    const admission = deps.admission === undefined
        ? undefined
        : await admissionOrUnavailable(deps.admission, senderKey, recipientDID)

    const mailboxKey = senderKey
    const messageId = deriveMessageId(envelope.payload.payload)
    const ref: MessageRef = {
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

    // The key binding, generation recycle and receive/append share one atomic
    // store operation so an obsolete-key put cannot slip between them.
    const pair = await store.appendPair(
        mailboxKey,
        ref,
        envelope.payload.nonce,
        nowSeconds,
        {
            senderDID: mailboxKey,
            anchorKey: declaration.anchorKey.x,
            declarationCID: declaration.declarationCID,
            revision: declaration.revision,
            car: declaration.evidenceCAR,
            expiresAt: nowSeconds + config.limits.messageExpirySeconds,
        },
        admission
    )
    if (pair.rejected !== undefined) return declarationUnverifiable()
    if (pair.result === undefined || pair.generation === undefined || pair.evidenceCID === undefined) {
        return declarationUnverifiable()
    }
    ref.pairGeneration = pair.generation
    ref.hint = { senderDID: mailboxKey, declarationCID: pair.evidenceCID }
    const result = pair.result
    if (result.outcome === "refused") {
        deps.defer(Promise.allSettled(pair.recycledMessageIds.map((id) => deps.bodies.deleteBody(id))))
        return new Response(null, {
            status: 429,
            headers: { "Retry-After": String(Math.max(0, result.retryAfter - nowSeconds)) },
        })
    }
    deps.defer(Promise.allSettled(pair.recycledMessageIds
        .filter((id) => !(("persistBody" in result) && result.persistBody && id === messageId))
        .map((id) => deps.bodies.deleteBody(id))))
    if (("persistBody" in result) && result.persistBody) {
        deps.defer((async () => {
            await storeBody()
            if (result.outcome === "appended" || result.outcome === "queued") {
                if ("moved" in result && result.moved) {
                    for (const moved of result.moved) {
                        try {
                            const body = await deps.bodies.getBody(moved.messageId)
                            if (body) await store.deliverLive?.(mailboxKey, moved, body)
                        } catch {}
                    }
                }
                try { await store.deliverLive?.(mailboxKey, ref, envelope.payload.payload) } catch {}
                try { await store.deliverPush?.(mailboxKey, ref, envelope.payload.payload) } catch {}
            }
        })())
    }
    return new Response(null, { status: 202 })
}

function declarationUnverifiable(): Response {
    return new Response(null, {
        status: 409,
        headers: { "Retry-After": String(DECLARATION_RETRY_AFTER_SECONDS) },
    })
}
