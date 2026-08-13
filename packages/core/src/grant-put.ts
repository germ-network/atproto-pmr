import { sha256 } from "@noble/hashes/sha2.js"
import { consumeChallenge } from "./challenge.js"
import { decodeCoseMap } from "./cose/cbor.js"
import { verifyGrantPutTag } from "./grant.js"
import { deriveMessageId } from "./message-id.js"
import { PMRConfig } from "./config.js"
import { BodyStore, ChallengeStore, Directory, Locator, PMRStore } from "./storage.js"
import { readBodyCapped } from "./util.js"

/**
 * Everything the grant-put handler needs, injected rather than reached for
 * — the same reasoning as `PairPutDeps`.
 */
export interface GrantPutDeps {
    config: PMRConfig
    directory: Directory
    store: (locator: Locator) => PMRStore
    bodies: BodyStore
    challenges: ChallengeStore
    /** Run work after the response has been produced — see below. */
    defer: (work: Promise<unknown>) => void
}

/**
 * `POST /pmr/v1/mailboxes/{address}/messages` — `spec/wire-api.md`, "The
 * grant-put payload" and "the closure exception".
 *
 * RESPONSE CONTRACT: `202`, always, for a well-formed request — no other
 * code, no timing difference between an unknown address, a closed one, a
 * live one, or a bad tag. This is stricter than the pair put's own
 * uniformity: a pair put resolves and verifies BEFORE answering and stays
 * uniform by always answering the same way; a grant put has no
 * self-referential disclosure to permit at all, so **no address-dependent
 * step runs before the response**. Only structurally-malformed-request
 * rejection — decided from the request bytes alone — happens synchronously.
 * Everything else is `deps.defer`red.
 */
export async function handleGrantPut(
    request: Request,
    address: string,
    deps: GrantPutDeps,
    nowSeconds: number
): Promise<Response> {
    const { config } = deps

    // --- Address-independent and synchronous. Malformed input is real
    // client error and safe to report distinctly. ---
    let nonce: string
    let tag: Uint8Array
    let message: Uint8Array
    try {
        const bodyBytes = await readBodyCapped(
            request,
            config.limits.messageMaxBytes + config.limits.framingAllowanceBytes
        )
        const map = decodeCoseMap(bodyBytes)
        const n = map.get("n")
        const t = map.get("t")
        const m = map.get("m")
        if (typeof n !== "string" || n.length === 0) {
            return new Response("Malformed grant put", { status: 400 })
        }
        if (!(t instanceof Uint8Array) || !(m instanceof Uint8Array)) {
            return new Response("Malformed grant put", { status: 400 })
        }
        if (m.byteLength > config.limits.messageMaxBytes) {
            return new Response("Payload exceeds the published maximum", {
                status: 400,
            })
        }
        nonce = n
        tag = t
        message = m
    } catch (e) {
        return new Response(`Malformed grant put: ${String(e)}`, {
            status: 400,
        })
    }

    // --- Everything below is address-dependent. Deferred past the
    // response by construction — see the module doc. ---
    deps.defer(deliver(address, nonce, tag, message, deps, nowSeconds))

    return new Response(null, { status: 202 })
}

async function deliver(
    address: string,
    nonce: string,
    tag: Uint8Array,
    message: Uint8Array,
    deps: GrantPutDeps,
    nowSeconds: number
): Promise<void> {
    const resolved = await deps.directory.resolveAddress(address)
    // Unknown or closed: same "do nothing" branch. Distinguishing them here
    // would be pointless — nothing downstream observes which happened,
    // since the response already left.
    if (resolved === null || resolved.closed) return

    const redemption = await consumeChallenge(
        nonce,
        { realm: "grantPut", subject: address },
        deps.challenges,
        nowSeconds
    )
    if (!redemption.valid) return

    const bodyDigest = sha256(message)
    const nonceBytes = new TextEncoder().encode(nonce)
    if (!verifyGrantPutTag(resolved.authKey, address, nonceBytes, bodyDigest, tag)) {
        return
    }

    const messageId = deriveMessageId(message)
    const ref = { messageId, byteLength: message.byteLength }
    const store = deps.store(resolved.locator)

    // Content-addressed dedup stands in for a per-sender anti-replay
    // nonce here — see `spec/wire-api.md#the-grant-put-payload` for why a
    // grant put does not need one. `bodyDigest` already exists and is
    // exactly a content address for `message`, so it doubles as the
    // "nonce" `append` records rather than introducing a second mechanism.
    const result = await store.append(address, ref, bodyDigest, nowSeconds)
    if (result.outcome === "appended" && result.persistBody) {
        await deps.bodies.putBody(
            messageId,
            message,
            nowSeconds + deps.config.limits.messageExpirySeconds
        )
    }
}
