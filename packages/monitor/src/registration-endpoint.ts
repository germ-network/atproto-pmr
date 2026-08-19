import {
    DEFAULT_LABEL,
    decodeCoseMap,
    encodeOkpEd25519Key,
    mintChallenge,
    parseOkpEd25519Key,
    parseSignatureInput,
    readBodyCapped,
    redeemChallenge,
    verifyRequestSignature,
    withNextChallenge,
    type ChallengeConfig,
    type ChallengeStore,
} from "@germ-network/atproto-pmr-core"
import type { MonitorRegistration, MonitorRegistrationStore } from "./registration.js"

/**
 * `POST`/`DELETE /monitor/v1/registration` — `spec/key-transparency.md`,
 * §Registration.
 *
 * PROVISIONAL BODY SHAPE, matching the PMR's owner endpoints: concrete CBOR
 * schemas are not yet published elsewhere either.
 *
 * ## Why a rebind cannot change the anchor key
 *
 * The PMR's own registration deliberately writes a freshly-declared key
 * through on re-registration (`owner/endpoints.ts`,
 * `handleRegistrationCreate`) — safe there because a key rotation would
 * otherwise lock the *owner* out of endpoints that verify against the
 * stored key, including the `DELETE` that would let them clean up.
 *
 * That argument does not transfer here. This component's adversary is
 * exactly the party that can publish a new declared key — a malicious or
 * compromised PDS. If a `POST` here accepted the newly-declared key the
 * same way the PMR does, a hostile PDS could publish a key swap and
 * immediately re-point (or delete) the victim's registration under the new
 * key — and the `t:"d"` push about the swap goes to the attacker, or
 * nowhere. `key-transparency.md` claims the opposite: "a PDS cannot rebind
 * or deregister the notification before swapping keys." That claim only
 * holds if every mutation of an EXISTING registration verifies against the
 * key stored at create time, forever — never the currently-declared one.
 *
 * So: `POST` with no existing registration verifies against the DID's
 * *currently declared* key (there is nothing else to check against — this
 * is publish-then-register, same as the PMR). `POST` with an existing
 * registration, and `DELETE`, both verify against the *stored* key,
 * unconditionally. The stored key itself is never rewritten by a `POST` —
 * only the push subscription fields are. A legitimate key rotation is
 * therefore `DELETE` (signed with the old stored key) followed by
 * re-`POST` (verifies against the newly-declared key) — never an in-place
 * rebind. See the spec for the client-facing statement of this flow.
 *
 * ## The self-healing lockout
 *
 * A device that loses its old anchor key (e.g. a reinstall) after rotating
 * cannot rebind or delete under the strict rule above. That is bounded: the
 * stranded subscription eventually answers 404/410 at the push service, the
 * deliverer's discard path drops the registration (own-DID push, a
 * separate module), and the device re-registers via the create path under
 * its now-current declared key.
 *
 * ## Failure discipline
 *
 * Every AUTHENTICATION failure is a bare `401` with no body and no
 * distinguishing reason, matching the PMR's owner endpoints: "no such
 * registration" must not be distinguishable from "bad signature", or
 * `POST` becomes a monitor-registration oracle for anyone who can mint an
 * anchor challenge (minting itself is pre-auth by design). `400`
 * (malformed body, only reachable once a real signer's request already
 * verified) and `413` (body too large, checked before any auth) are
 * distinct and expected — neither leaks anything about a specific DID's
 * registration state.
 *
 * One accepted, narrower leak: create and rebind take visibly different
 * paths (create resolves the DID's declaration over the network; rebind
 * only reads the store), so response latency alone can reveal WHETHER a
 * DID has a registration, to anyone who can mint a challenge for it. See
 * `MonitorRegistrationStore`'s doc comment (`registration.ts`) for why this
 * is accepted rather than closed in v1.
 */

const BODY_MAX_BYTES = 16 * 1024

export interface MonitorRegistrationDeps {
    registrations: MonitorRegistrationStore
    challenges: ChallengeStore
    /** DID → declared anchor key, as raw Ed25519 bytes, or `null` if
     *  unresolvable. Injected — the monitor is generic over which
     *  collection carries the key. */
    resolveAnchorKey: (did: string) => Promise<Uint8Array | null>
    nowSeconds: number
    label?: string
    /** Supplied to amortize the mint on `POST` success, matching the PMR's
     *  owner endpoints. Omit to disable — every call then costs a mint. */
    challengeConfig?: ChallengeConfig
    randomBytes?: (n: number) => Uint8Array
}

/** Mirrors `owner/endpoints.ts`'s `amortize` — see its comment. Not shared
 *  because that one is a private module helper, not part of core's public
 *  surface. */
async function amortize(
    response: Response,
    did: string,
    deps: MonitorRegistrationDeps
): Promise<Response> {
    if (deps.challengeConfig === undefined || deps.randomBytes === undefined) {
        return response
    }
    try {
        const minted = await mintChallenge(
            { realm: "anchor", subject: did },
            {
                store: deps.challenges,
                config: deps.challengeConfig,
                nowSeconds: deps.nowSeconds,
                randomBytes: deps.randomBytes,
            }
        )
        return withNextChallenge(response, minted)
    } catch {
        return response
    }
}

async function readNonce(
    request: Request,
    label: string
): Promise<string | null> {
    const inputHeader = request.headers.get("signature-input")
    if (inputHeader === null) return null
    try {
        const value = parseSignatureInput(inputHeader).get(label)?.params.get("nonce")
        return typeof value === "string" && value.length > 0 ? value : null
    } catch {
        return null
    }
}

function parseSubscription(
    body: Uint8Array
): MonitorRegistration["pushSubscription"] | null {
    try {
        const map = decodeCoseMap(body)
        const endpoint = map.get("pse")
        const contentKey = map.get("psk")
        const keyId = map.get("psi")
        if (
            typeof endpoint !== "string" ||
            !(contentKey instanceof Uint8Array) ||
            contentKey.byteLength !== 32 ||
            typeof keyId !== "number" ||
            !Number.isInteger(keyId) ||
            keyId < 0 ||
            keyId > 255
        ) {
            return null
        }
        let parsedEndpoint: URL
        try {
            parsedEndpoint = new URL(endpoint)
        } catch {
            return null
        }
        if (parsedEndpoint.protocol !== "https:") return null
        return { endpoint, contentKey, keyId }
    } catch {
        return null
    }
}

/** `POST /monitor/v1/registration` — create, or rebind the subscription. */
export async function handleMonitorRegistrationCreate(
    request: Request,
    deps: MonitorRegistrationDeps
): Promise<Response> {
    let body: Uint8Array
    try {
        body = await readBodyCapped(request, BODY_MAX_BYTES)
    } catch {
        return new Response("Body too large", { status: 413 })
    }

    const label = deps.label ?? DEFAULT_LABEL
    const nonce = await readNonce(request, label)
    if (nonce === null) return new Response(null, { status: 401 })

    const redeemed = await redeemChallenge(nonce, "anchor", deps.challenges)
    if (!redeemed.valid) return new Response(null, { status: 401 })
    const did = redeemed.binding.subject

    const existing = await deps.registrations.load(did)

    // See the module comment: the stored key is set once, at create, and
    // never rewritten by a later POST.
    let anchorKey: Uint8Array
    if (existing !== null) {
        anchorKey = existing.anchorKey
    } else {
        const declared = await deps.resolveAnchorKey(did)
        if (declared === null) return new Response(null, { status: 401 })
        anchorKey = encodeOkpEd25519Key({ x: declared })
    }

    const verified = verifyRequestSignature({
        request,
        body,
        publicKey: parseOkpEd25519Key(anchorKey).x,
        nowSeconds: deps.nowSeconds,
        label,
    })
    if (!verified.valid) return new Response(null, { status: 401 })

    const subscription = parseSubscription(body)
    if (subscription === null) {
        return new Response("Malformed body", { status: 400 })
    }

    await deps.registrations.put({
        did,
        anchorKey,
        pushSubscription: subscription,
        registeredAt: deps.nowSeconds,
    })

    return amortize(new Response(null, { status: 201 }), did, deps)
}

/** `DELETE /monitor/v1/registration` — deregister. */
export async function handleMonitorRegistrationDelete(
    request: Request,
    deps: MonitorRegistrationDeps
): Promise<Response> {
    let body: Uint8Array | null = null
    if (request.body !== null) {
        try {
            body = await readBodyCapped(request, BODY_MAX_BYTES)
        } catch {
            return new Response("Body too large", { status: 413 })
        }
    }

    const label = deps.label ?? DEFAULT_LABEL
    const nonce = await readNonce(request, label)
    if (nonce === null) return new Response(null, { status: 401 })

    const redeemed = await redeemChallenge(nonce, "anchor", deps.challenges)
    if (!redeemed.valid) return new Response(null, { status: 401 })
    const did = redeemed.binding.subject

    const existing = await deps.registrations.load(did)
    if (existing === null) return new Response(null, { status: 401 })

    const verified = verifyRequestSignature({
        request,
        body,
        publicKey: parseOkpEd25519Key(existing.anchorKey).x,
        nowSeconds: deps.nowSeconds,
        label,
    })
    if (!verified.valid) return new Response(null, { status: 401 })

    await deps.registrations.delete(did)
    // Idempotent: a second DELETE finds no registration and 401s (there is
    // no stored key left to verify against) — indistinguishable from any
    // other "no such registration" failure, by design. No next-challenge
    // here — nothing is left to bind it to.
    return new Response(null, { status: 204 })
}
