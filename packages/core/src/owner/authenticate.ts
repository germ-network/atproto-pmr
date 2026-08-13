import { redeemChallenge } from "../challenge.js"
import { parseSignatureInput } from "../http-sig/structured-fields.js"
import { DEFAULT_LABEL, verifyRequestSignature } from "../http-sig/verify.js"
import { parseOkpEd25519Key } from "../cose/key.js"
import type { ChallengeStore, Locator, PMRStore } from "../storage.js"

/**
 * Authenticating an owner-facing request.
 *
 * ## The ordering is the security argument
 *
 * An owner endpoint names no subject — the resources are singular, because
 * "the authenticated identity determines whose registration is addressed".
 * So the DID has to come from somewhere, and the only candidates are the
 * message (which we must never trust) or the challenge binding.
 *
 * It comes from the binding, and the order is:
 *
 *   1. read the nonce out of `Signature-Input` — parsed, **not trusted**
 *   2. redeem it, learning which DID the server bound it to at mint
 *   3. resolve *that* DID's registration to get its anchor key
 *   4. verify the signature against that key
 *
 * Step 2 alone proves nothing: a stolen challenge names its rightful owner
 * and is useless without their key. Step 4 is what proves possession. The
 * binding decides **which key to check**; the signature decides **whether
 * the caller holds it**. Neither half authenticates on its own, which is
 * why nothing here short-circuits when one of them looks convincing.
 *
 * ## Why redemption happens before verification
 *
 * It costs a challenge on a request that then fails to verify, and that is
 * deliberate: the challenge is spent regardless of outcome, so an attempt
 * cannot be retried into a different verdict. The alternative — verify
 * first, redeem after — would let an attacker probe signatures against a
 * challenge indefinitely.
 *
 * The cost is bounded and self-inflicted: burning a challenge requires
 * already holding it, and an attacker who holds one could equally replay
 * the whole request. That is exactly why every challenge-reachable
 * operation must be replay-tolerant within the TTL.
 */

export type OwnerAuthOutcome =
    | {
          authenticated: true
          /** The DID the challenge was bound to, now proven by signature. */
          did: string
          locator: Locator
          store: PMRStore
      }
    /**
     * One shape for every failure, and callers MUST answer `401` without
     * saying which check failed. Distinguishing "no such registration" from
     * "bad signature" from "unknown challenge" turns this endpoint into a
     * registration oracle.
     */
    | { authenticated: false; reason: string }

export interface OwnerAuthDeps {
    challenges: ChallengeStore
    /**
     * DID → the store for that relay, or `null` if this deployment does not
     * serve it.
     */
    resolveLocator: (did: string) => Promise<Locator | null>
    store: (locator: Locator) => PMRStore
    nowSeconds: number
    label?: string
}

export async function authenticateOwner(
    request: Request,
    body: Uint8Array | null,
    deps: OwnerAuthDeps
): Promise<OwnerAuthOutcome> {
    const label = deps.label ?? DEFAULT_LABEL

    // (1) Read the nonce. Parsed only — nothing here is trusted yet, and
    // this deliberately does no crypto, because we do not yet know which
    // key the crypto would be against.
    const inputHeader = request.headers.get("signature-input")
    if (inputHeader === null) {
        return { authenticated: false, reason: "unsigned request" }
    }
    let nonce: string
    try {
        const entry = parseSignatureInput(inputHeader).get(label)
        const value = entry?.params.get("nonce")
        if (typeof value !== "string" || value.length === 0) {
            return { authenticated: false, reason: "missing nonce" }
        }
        nonce = value
    } catch {
        return { authenticated: false, reason: "malformed signature-input" }
    }

    // (2) Redeem. This is what names the claimed identity, and spends the
    // challenge whatever happens next.
    const redeemed = await redeemChallenge(nonce, "anchor", deps.challenges)
    if (!redeemed.valid) {
        return { authenticated: false, reason: "challenge not redeemable" }
    }
    const did = redeemed.binding.subject

    // (3) Resolve that DID's registration. The anchor key comes from
    // storage, populated at registration from the DID's declaration and
    // kept current by the declaration watch — never from the message.
    const locator = await deps.resolveLocator(did)
    if (locator === null) {
        return { authenticated: false, reason: "no registration" }
    }
    const store = deps.store(locator)
    const registration = await store.load()
    if (registration === null) {
        return { authenticated: false, reason: "no registration" }
    }

    // (4) Verify against that key. Only now is the claim proven.
    const verified = verifyRequestSignature({
        request,
        body,
        publicKey: anchorKeyBytes(registration.anchorKey),
        nowSeconds: deps.nowSeconds,
        label,
    })
    if (!verified.valid) {
        return { authenticated: false, reason: verified.reason }
    }

    return { authenticated: true, did, locator, store }
}

/**
 * The stored anchor key is a `COSE_Key` blob — self-describing, never a
 * fixed-width column, so a post-quantum algorithm arrives as a new
 * identifier rather than a schema migration. That is a MUST in the storage
 * consistency contract, and storing raw key bytes would satisfy the
 * verifier today while quietly making the next algorithm a migration.
 *
 * `parseOkpEd25519Key` rejects any other `kty`/`crv` rather than guessing:
 * handing the wrong bytes to a verifier fails closed only because the
 * verifier is strict, and that is not a coincidence worth depending on.
 */
function anchorKeyBytes(stored: Uint8Array): Uint8Array {
    return parseOkpEd25519Key(stored).x
}
