import { redeemChallenge } from "../challenge.js"
import { encodeOkpEd25519Key } from "../cose/key.js"
import { decodeCoseMap, encodeCose, type CoseValue } from "../cose/cbor.js"
import { deriveGrantAddress } from "../grant.js"
import { parseSignatureInput } from "../http-sig/structured-fields.js"
import { DEFAULT_LABEL, verifyRequestSignature } from "../http-sig/verify.js"
import { asPairMailboxKey, isPairMailboxKey } from "../mailbox-key.js"
import { binaryToBase64URL, readBodyCapped, toResponseBody } from "../util.js"
import type {
    Directory,
    PairMailboxKey,
    RegistrationFields,
} from "../storage.js"
import { mintChallenge, type ChallengeConfig } from "../challenge.js"
import { withNextChallenge } from "../challenge-endpoint.js"
import {
    authenticateOwner,
    type OwnerAuthDeps,
    type OwnerAuthOutcome,
} from "./authenticate.js"

/**
 * The owner-facing surface: registrations, blocks, and pool adjudication.
 *
 * PROVISIONAL BODY SHAPES, as with the challenge mint — concrete CBOR
 * schemas are not yet published. Single-letter keys follow the wire
 * vocabulary already in use.
 *
 * ## Error semantics differ from the peer-facing paths, deliberately
 *
 * A peer put answers uniformly so that closure holds. An owner gets **real,
 * actionable codes**, because their retry logic depends on distinguishing
 * transient from terminal, and because they are already authenticated —
 * there is no identity to protect from itself.
 *
 * The one thing an owner endpoint must NOT distinguish is *why*
 * authentication failed. Every failure is `401` with no detail: separating
 * "no such registration" from "bad signature" would turn this into a
 * registration oracle for anyone who can mint a challenge.
 */

const OWNER_BODY_MAX_BYTES = 16 * 1024

export interface OwnerDeps extends OwnerAuthDeps {
    directory: Directory
    /** How long a discard suppresses a sender, in seconds. */
    discardWindowSeconds: number
    /**
     * Supplied to amortize the mint: every authenticated response carries a
     * fresh challenge, so a client pays the mint round trip only on its
     * first request. Omit to disable — every call then costs a mint.
     */
    challengeConfig?: ChallengeConfig
    randomBytes?: (n: number) => Uint8Array
}

/**
 * Attach a fresh challenge to an authenticated response.
 *
 * Minted for the DID that just authenticated, so it is bound to them and
 * useless to anyone who intercepts it. Failures are swallowed
 * deliberately: the operation already succeeded, and turning a
 * convenience into a 500 would be a worse answer than making the client
 * pay for one more mint.
 */
async function amortize(
    response: Response,
    did: string,
    deps: OwnerDeps
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

async function authed(
    request: Request,
    deps: OwnerDeps
): Promise<
    | { ok: true; auth: Extract<OwnerAuthOutcome, { authenticated: true }>; body: Uint8Array | null }
    | { ok: false; response: Response }
> {
    let body: Uint8Array | null = null
    if (request.body !== null) {
        try {
            body = await readBodyCapped(request, OWNER_BODY_MAX_BYTES)
        } catch {
            return { ok: false, response: new Response("Body too large", { status: 413 }) }
        }
    }
    const auth = await authenticateOwner(request, body, deps)
    if (!auth.authenticated) {
        // No detail, ever. See the header comment.
        return { ok: false, response: new Response(null, { status: 401 }) }
    }
    return { ok: true, auth, body }
}

function cbor(entries: [string, CoseValue][], status = 200): Response {
    return new Response(toResponseBody(encodeCose(new Map(entries))), {
        status,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
    })
}

// MARK: - Registration

/**
 * `POST /pmr/v1/registrations` — create.
 *
 * The **only** owner endpoint that authenticates against a key it does not
 * already store, because there is no registration yet. The anchor key comes
 * from the DID's declaration, resolved by the caller, never from the
 * request body: a body-supplied key would let an attacker register any DID
 * they liked by signing with their own key.
 *
 * Idempotent on DID, so a retry inside the challenge TTL is safe — which
 * is what makes this operation challenge-reachable at all.
 */
export async function handleRegistrationCreate(
    request: Request,
    deps: OwnerDeps & {
        /**
         * DID → declared anchor key, as raw Ed25519 bytes. The
         * registration's root of trust. Stored as a `COSE_Key` blob, never
         * as the raw bytes — see `RegistrationFields.anchorKey`.
         */
        resolveAnchorKey: (did: string) => Promise<Uint8Array | null>
        /** The DID being registered, taken from the redeemed challenge. */
        nowSeconds: number
    }
): Promise<Response> {
    let body: Uint8Array | null = null
    if (request.body !== null) {
        try {
            body = await readBodyCapped(request, OWNER_BODY_MAX_BYTES)
        } catch {
            return new Response("Body too large", { status: 413 })
        }
    }

    // Create cannot use `authenticateOwner`, which resolves the key from an
    // existing registration. Redeem first to learn the DID, then take the
    // key from that DID's declaration.
    const label = deps.label ?? DEFAULT_LABEL

    const inputHeader = request.headers.get("signature-input")
    if (inputHeader === null) return new Response(null, { status: 401 })
    let nonce: string
    try {
        const value = parseSignatureInput(inputHeader).get(label)?.params.get("nonce")
        if (typeof value !== "string" || value.length === 0) {
            return new Response(null, { status: 401 })
        }
        nonce = value
    } catch {
        return new Response(null, { status: 401 })
    }

    const redeemed = await redeemChallenge(nonce, "anchor", deps.challenges)
    if (!redeemed.valid) return new Response(null, { status: 401 })
    const did = redeemed.binding.subject

    const anchorKey = await deps.resolveAnchorKey(did)
    if (anchorKey === null) return new Response(null, { status: 401 })

    const verified = verifyRequestSignature({
        request,
        body,
        publicKey: anchorKey,
        nowSeconds: deps.nowSeconds,
        label,
    })
    if (!verified.valid) return new Response(null, { status: 401 })

    const fields: RegistrationFields = {
        did,
        // Self-describing on the way in, so nothing downstream has to know
        // which algorithm produced it.
        anchorKey: encodeOkpEd25519Key({ x: anchorKey }),
        lastActive: deps.nowSeconds,
    }
    // A push grant may accompany the registration. It is a capability —
    // an id, a symmetric key, an expiry — and never a push token.
    if (body !== null && body.byteLength > 0) {
        try {
            const map = decodeCoseMap(body)
            const id = map.get("pgi")
            const key = map.get("pgk")
            const expiry = map.get("pge")
            if (
                typeof id === "string" &&
                key instanceof Uint8Array &&
                typeof expiry === "number"
            ) {
                fields.pushGrant = { id, key, expiry }
            }
        } catch {
            return new Response("Malformed body", { status: 400 })
        }
    }

    const locator = await deps.directory.create(did, fields)

    // `create` is idempotent on DID and returns the existing locator
    // **without touching its fields**, so re-registering an existing DID
    // would leave a stale anchor key in place. That matters because
    // re-registration is the recovery path from a key rotation: every owner
    // endpoint verifies against the STORED key, so an owner who rotated
    // their declared key would otherwise be locked out of their own
    // registration — including the ability to delete it — with mail still
    // arriving.
    //
    // Writing through is safe precisely because of what was checked above:
    // the signature verified against the key in the DID's CURRENT
    // declaration, which only that DID's controller can change. An attacker
    // cannot reach this line without already holding the key they would be
    // installing.
    //
    // `pushGrant` is written only when the request carried one, so
    // re-registering to refresh a key does not silently drop push delivery.
    await deps.store(locator).update({
        anchorKey: fields.anchorKey,
        lastActive: fields.lastActive,
        ...(fields.pushGrant !== undefined
            ? { pushGrant: fields.pushGrant }
            : {}),
    })

    return cbor([["l", locator]], 201)
}

/** `GET /pmr/v1/registration` — read own. */
export async function handleRegistrationRead(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    const reg = await a.auth.store.load()
    if (reg === null) return new Response(null, { status: 404 })
    return amortize(
        cbor([
        ["did", reg.did],
        ["la", reg.lastActive],
        // The push grant's key is never echoed back; only whether one exists.
        ["pg", reg.pushGrant !== undefined],
        ]),
        a.auth.did,
        deps
    )
}

/** `DELETE /pmr/v1/registration` — deregister. */
export async function handleRegistrationDelete(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    await deps.directory.delete(a.auth.did)
    // Idempotent: deleting an already-deleted registration succeeds, so a
    // retry inside the challenge TTL is safe. No next-challenge here — the
    // registration this one would be bound to no longer exists.
    return new Response(null, { status: 204 })
}

// MARK: - Blocks

/** `GET /pmr/v1/blocks` — list blocked sender DIDs. */
export async function handleBlocksList(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response
    const dids = await a.auth.store.listBlocked()
    return amortize(cbor([["b", dids]]), a.auth.did, deps)
}

/**
 * `PUT /pmr/v1/blocks/{did}` and `DELETE /pmr/v1/blocks/{did}`.
 *
 * This is only the **pair-mailbox half** of a user-level block. A relay can
 * suppress a grant mailbox too — that is `PATCH /grants/{address}` with
 * `{closed:true}` — but it cannot map an address back to a sender, so the
 * device has to name the addresses. A person-level block is a client-side
 * composite for want of a mapping, not for want of a capability.
 */
export async function handleBlockSet(
    request: Request,
    senderDID: string,
    blocked: boolean,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    if (!isPairMailboxKey(senderDID)) {
        return new Response("Not a DID", { status: 400 })
    }
    if (blocked) {
        await a.auth.store.block(senderDID, deps.nowSeconds)
    } else {
        await a.auth.store.unblock(senderDID)
    }
    // Idempotent both ways — blocking an already-blocked sender, or
    // unblocking one who is not blocked, both succeed.
    return amortize(new Response(null, { status: 204 }), a.auth.did, deps)
}

// MARK: - Pool

/** `GET /pmr/v1/pool` — DIDs only, never bodies. */
export async function handlePoolList(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    const senders = await a.auth.store.poolSenders()
    return amortize(
        cbor([
        [
            "p",
            senders.map(
                (s) => new Map<string, CoseValue>([
                    ["did", s.did],
                    ["n", s.count],
                ])
            ),
        ],
        ]),
        a.auth.did,
        deps
    )
}

/**
 * `POST /pmr/v1/pool/adjudication` — provision-or-discard, per DID.
 *
 * The server pooled these senders precisely because it could not evaluate
 * them, so it does not act as though it can: it offers the device the only
 * judgement that exists and acts on the answer. Two structural consequences
 * — "no open DMs" stops being an unstated client-side filter and becomes a
 * protocol step, and the pool becomes self-clearing.
 *
 * Body: `{ "prov": [did…], "disc": [did…] }`.
 */
export async function handlePoolAdjudication(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response
    if (a.body === null) return new Response("Missing body", { status: 400 })

    let provision: PairMailboxKey[] = []
    let discard: PairMailboxKey[] = []
    try {
        const map = decodeCoseMap(a.body)
        provision = stringList(map.get("prov")).map(asPairMailboxKey)
        discard = stringList(map.get("disc")).map(asPairMailboxKey)
    } catch {
        return new Response("Malformed body", { status: 400 })
    }

    // A DID named in both is a contradiction the device has to resolve, not
    // something to silently pick a winner for.
    const overlap = provision.filter((d) => discard.includes(d))
    if (overlap.length > 0) {
        return new Response("A DID appears in both lists", { status: 409 })
    }

    let provisioned = 0
    for (const did of provision) {
        const moved = await a.auth.store.provisionFromPool(did, deps.nowSeconds)
        provisioned += moved.length
    }
    for (const did of discard) {
        // Time-bounded, never standing: the device discards a DID it does
        // not recognize *at that moment*, and the pool exists for exactly
        // the case where its own knowledge is behind.
        await a.auth.store.discardFromPool(
            did,
            deps.nowSeconds + deps.discardWindowSeconds
        )
    }

    return amortize(
        cbor([
            ["pr", provision.length],
            ["di", discard.length],
            ["m", provisioned],
        ]),
        a.auth.did,
        deps
    )
}

function stringList(v: CoseValue | undefined): string[] {
    if (v === undefined) return []
    if (!Array.isArray(v)) throw new Error("expected an array")
    return v.map((x) => {
        if (typeof x !== "string") throw new Error("expected strings")
        return x
    })
}

// MARK: - Grants

/**
 * Deps specific to grant issuance, on top of `OwnerDeps`.
 *
 * Split out rather than folded into `OwnerDeps` because `randomBytes` there
 * is optional (amortize degrades gracefully without it) while a missing
 * source of randomness here is not something these handlers can degrade
 * around — issuing a grant IS generating a fresh secret.
 */
export interface GrantConfig {
    /** Domain-separates address derivation — `wire-api.md`, "Grant address
     *  and put-tag derivation". */
    hostName: string
    /** How long an issued grant lives before it must be reissued, seconds. */
    grantExpirySeconds: number
    /** Refuses a single request asking for more than this many at once. */
    maxGrantsPerRequest: number
    randomBytes: (n: number) => Uint8Array
}

/**
 * `POST /pmr/v1/grants` — request N; returns `{key, address, expiry}`
 * triples, the exact wire vocabulary `wire-api.md`'s endpoint table names.
 *
 * The address a client is handed here is the SAME thing it MUST re-derive
 * and verify locally (`wire-api.md#grants--the-core-capability`) — this
 * handler does not get to special-case its own output.
 */
export async function handleGrantsCreate(
    request: Request,
    deps: OwnerDeps & GrantConfig
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    let count: number
    try {
        const map = decodeCoseMap(a.body ?? new Uint8Array(0))
        const n = map.get("count")
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
            return new Response("Malformed grant request", { status: 400 })
        }
        count = n
    } catch (e) {
        return new Response(`Malformed grant request: ${String(e)}`, {
            status: 400,
        })
    }
    if (count > deps.maxGrantsPerRequest) {
        return new Response("Too many grants requested", { status: 400 })
    }

    const expiresAt = deps.nowSeconds + deps.grantExpirySeconds
    const issued: CoseValue[] = []
    for (let i = 0; i < count; i++) {
        const authKey = deps.randomBytes(32)
        const address = deriveGrantAddress(authKey, deps.hostName)
        const addressString = binaryToBase64URL(address)

        // Owner record first, then the routing row — the opposite of
        // registration's directory.create + store.update. Order decides
        // the partial-failure state: this way leaves a grant that is
        // listed and deletable but routes nothing, where the reverse
        // leaves one puts reach while `getGrant` returns null, so
        // `PATCH`/`DELETE` answer 404 and it cannot be revoked before it
        // expires.
        await a.auth.store.issueGrant(addressString, authKey, expiresAt)
        await deps.directory.createGrantAddress(
            a.auth.locator,
            addressString,
            authKey,
            expiresAt
        )

        issued.push(
            new Map<string, CoseValue>([
                ["key", authKey],
                ["address", addressString],
                ["expiry", expiresAt],
            ])
        )
    }

    return amortize(cbor([["grants", issued]], 201), a.auth.did, deps)
}

/** `GET /pmr/v1/grants` — list live grants. Never re-serves `key`. */
export async function handleGrantsList(
    request: Request,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    const grants = await a.auth.store.listGrants()
    return amortize(
        cbor([
            [
                "grants",
                grants.map(
                    (g) =>
                        new Map<string, CoseValue>([
                            ["address", g.address],
                            ["expiry", g.expiresAt],
                            ["closed", g.closed],
                        ])
                ),
            ],
        ]),
        a.auth.did,
        deps
    )
}

/**
 * `PATCH /pmr/v1/grants/{address}` — `{closed: true|false}`, reversible.
 * State transitions are a `PATCH` on the resource rather than `…/close`
 * and `…/reopen` action endpoints (`wire-api.md`).
 */
export async function handleGrantSet(
    request: Request,
    address: string,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    let closed: boolean
    try {
        const map = decodeCoseMap(a.body ?? new Uint8Array(0))
        const c = map.get("closed")
        if (typeof c !== "boolean") {
            return new Response("Malformed grant update", { status: 400 })
        }
        closed = c
    } catch (e) {
        return new Response(`Malformed grant update: ${String(e)}`, {
            status: 400,
        })
    }

    // The owner names an address by VALUE. This is what confirms it is
    // actually theirs before the global routing row is touched — a `PATCH`
    // that trusted the path segment alone would let any owner close or
    // reopen any other owner's grant by guessing or observing its address.
    const existing = await a.auth.store.getGrant(address)
    if (existing === null) {
        return new Response("No such grant", { status: 404 })
    }

    await a.auth.store.setGrantClosed(address, closed)
    await deps.directory.setGrantAddressClosed(address, closed)

    return amortize(new Response(null, { status: 204 }), a.auth.did, deps)
}

/** `DELETE /pmr/v1/grants/{address}` — invalidate permanently. */
export async function handleGrantDelete(
    request: Request,
    address: string,
    deps: OwnerDeps
): Promise<Response> {
    const a = await authed(request, deps)
    if (!a.ok) return a.response

    // Same ownership check as `handleGrantSet`, and for the same reason.
    const existing = await a.auth.store.getGrant(address)
    if (existing === null) {
        return new Response("No such grant", { status: 404 })
    }

    await a.auth.store.invalidateGrant(address)
    await deps.directory.deleteGrantAddress(address)

    return amortize(new Response(null, { status: 204 }), a.auth.did, deps)
}
