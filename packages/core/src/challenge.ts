import { binaryToBase64URL } from "./util.js"
import type { ChallengeStore } from "./storage.js"

/**
 * Server-issued challenges — `spec/wire-api.md`, "Request authentication"
 * and "Freshness and replay".
 *
 * The property is **freshness with bounded replay, not use-once.** A
 * signature cannot exist before the server issued the challenge it covers,
 * and is valid only inside that challenge's TTL. Strict single-use is
 * deliberately not claimed: it needs an atomic consume not every backend
 * can provide, and best-effort consumption narrows the replay window
 * without closing it.
 *
 * So replay containment lives at the *operation*, and that is a
 * requirement on every caller: **every challenge-reachable operation MUST
 * be replay-tolerant within the TTL** — idempotent, content-addressed and
 * deduplicated, or independently sequenced. Right-size the TTL to that
 * tolerance rather than treating a spent challenge as a guarantee.
 */

/**
 * The two authorization realms, distinguished by **the key that signs**
 * rather than by separate endpoint families.
 *
 * An Atproto PMR implements exactly one — `anchor` — because push reaches
 * its users by delegation rather than by holding a push token. `registration`
 * exists so the type is complete and so a cross-realm challenge is
 * expressible (and therefore rejectable) rather than unrepresentable.
 */
export type Realm = "anchor" | "registration"

/**
 * What a challenge authorizes. Bound **at mint**, which is what the client
 * cannot restate: it decides neither the realm nor the subject, so a
 * challenge issued for one purpose cannot be spent on another.
 */
export interface ChallengeBinding {
    realm: Realm
    /**
     * The identity or destination this challenge authorizes — a DID for
     * DID-scoped operations, a mailbox address for a put.
     */
    subject: string
}

export interface ChallengeConfig {
    ttlSeconds: number
    /** Nonce width. 32 bytes is the germ-service precedent. */
    byteLength: number
}

export interface MintDeps {
    store: ChallengeStore
    config: ChallengeConfig
    nowSeconds: number
    /**
     * Injected so tests are deterministic. Defaults to `crypto.getRandomValues`
     * at the call site; this package never reaches for a platform global.
     */
    randomBytes: (n: number) => Uint8Array
}

export interface MintedChallenge {
    /** base64url, no padding. Carried in the RFC 9421 `nonce` parameter. */
    challenge: string
    expiresAt: number
}

/**
 * Serializing the binding rather than storing a struct keeps
 * `ChallengeStore` to a string value, which is what lets an adapter back it
 * with a plain KV or a MAC'd stateless token.
 *
 * The realm is a **prefix**, so a cross-realm compare fails on the first
 * segment and cannot be defeated by a subject that happens to contain the
 * separator.
 */
export function encodeBinding(b: ChallengeBinding): string {
    return `${b.realm}:${b.subject}`
}

export function decodeBinding(s: string): ChallengeBinding | null {
    const sep = s.indexOf(":")
    if (sep < 1) return null
    const realm = s.slice(0, sep)
    if (realm !== "anchor" && realm !== "registration") return null
    return { realm, subject: s.slice(sep + 1) }
}

/**
 * Mints a challenge bound to a realm and a subject.
 *
 * **The mint is the control point.** It is where a server declines,
 * rate-limits, or applies policy — before any body is parsed and before any
 * signature exists. That is the whole reason for a server-issued challenge
 * over client-asserted timestamps: the client cannot pre-sign for a future
 * window, and every claim in the eventual request traces back to something
 * the server chose to issue.
 *
 * Callers are expected to apply their policy *before* calling this.
 */
export async function mintChallenge(
    binding: ChallengeBinding,
    deps: MintDeps
): Promise<MintedChallenge> {
    const challenge = binaryToBase64URL(
        deps.randomBytes(deps.config.byteLength)
    )
    const expiresAt = deps.nowSeconds + deps.config.ttlSeconds
    await deps.store.mint(challenge, encodeBinding(binding), expiresAt)
    return { challenge, expiresAt }
}

export type ConsumeOutcome =
    | { valid: true; binding: ChallengeBinding }
    /**
     * Deliberately one reason for every failure. A caller answering an
     * owner-facing request may report `401` for any of them, but MUST NOT
     * report *which*: distinguishing "unknown" from "expired" from "wrong
     * realm" tells an attacker whether a challenge they hold was ever
     * issued, and distinguishing wrong-realm tells them a subject exists in
     * the other realm.
     */
    | { valid: false }

/**
 * Redeems a challenge and checks it was issued for this exact purpose.
 *
 * **Cross-realm redemption is refused here, structurally**: `expected` is a
 * required parameter, so a call site cannot forget to compare and cannot
 * compare *after* acting. The realms' revocation clocks are unrelated —
 * registration-key dormancy versus key-in-declaration — so a challenge that
 * verified across them would let one realm's lifetime silently authorize
 * the other's operations.
 *
 * Consumption is best-effort by contract. This deletes before deciding, so
 * a challenge is spent regardless of outcome — the same delete-then-verify
 * order germ-service uses — but a caller MUST NOT treat that as
 * exactly-once.
 */
export async function consumeChallenge(
    challenge: string,
    expected: ChallengeBinding,
    store: ChallengeStore,
    nowSeconds: number
): Promise<ConsumeOutcome> {
    const boundTo = await store.consume(challenge)
    if (boundTo === null) return { valid: false }

    const binding = decodeBinding(boundTo)
    if (binding === null) return { valid: false }
    if (binding.realm !== expected.realm) return { valid: false }
    if (binding.subject !== expected.subject) return { valid: false }

    void nowSeconds // expiry is enforced by the store's read (contract 4)
    return { valid: true, binding }
}

/**
 * The response header carrying the next challenge, so a client holds a
 * fresh one at all times and pays the mint round trip only on its first
 * request.
 *
 * A Structured Fields (RFC 9651) Byte Sequence with a Date-typed `expires`
 * parameter — `:<base64>:; expires=@<epoch>` — not a bare integer, since
 * the field syntax is Structured Fields throughout.
 *
 * NOTE: the vendor-prefixed field name is listed as unsettled in the
 * public spec. It is a constant here so that settling it is one edit.
 */
export const NEXT_CHALLENGE_HEADER = "Germ-Next-Challenge"

export function nextChallengeHeaderValue(minted: MintedChallenge): string {
    // The challenge is base64url for the `nonce` parameter; a Structured
    // Fields Byte Sequence is standard base64. Re-encode rather than emit
    // base64url inside `::`, which a conforming SF parser would reject.
    const standard = minted.challenge.replace(/-/g, "+").replace(/_/g, "/")
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4)
    return `:${padded}:; expires=@${minted.expiresAt}`
}

/**
 * Redeem a challenge knowing only the **realm**, and learn the subject
 * from the binding.
 *
 * This exists because the two callers know different things.
 * `consumeChallenge` is for an operation whose subject the request already
 * names — a put to a known address — where checking the binding against
 * that subject is the point.
 *
 * An owner-facing request names no subject: the endpoints are singular
 * ("the authenticated identity determines whose registration is
 * addressed"), so the DID has to come from the binding itself. That is
 * safe only because the binding alone proves nothing. It says which key to
 * check; the signature over the request is what proves possession of it.
 * A stolen challenge names its rightful owner and is useless without their
 * key.
 *
 * Do not use this where the subject is knowable from the request —
 * checking a binding you could have verified is strictly stronger.
 */
export async function redeemChallenge(
    challenge: string,
    realm: Realm,
    store: ChallengeStore
): Promise<ConsumeOutcome> {
    const boundTo = await store.consume(challenge)
    if (boundTo === null) return { valid: false }

    const binding = decodeBinding(boundTo)
    if (binding === null) return { valid: false }
    if (binding.realm !== realm) return { valid: false }
    return { valid: true, binding }
}
