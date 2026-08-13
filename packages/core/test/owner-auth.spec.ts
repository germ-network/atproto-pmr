/**
 * Owner authentication — the composition of challenge redemption and
 * signature verification.
 *
 * The property under test is that **neither half authenticates alone**. The
 * binding says which key to check; the signature says whether the caller
 * holds it. Each test below breaks exactly one half and expects a refusal.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { authenticateOwner } from "../src/owner/authenticate"
import { encodeBinding } from "../src/challenge"
import { signRequest } from "../src/http-sig/sign"
import type {
    ChallengeStore,
    Locator,
    PMRStore,
    RegistrationFields,
} from "../src/storage"

const T0 = 1_760_000_000
const URL_ = "https://relay.example/pmr/v1/registration"
const ALICE = "did:plc:alice00000000000000000"
const MALLORY = "did:plc:mallory000000000000000"

function memoryChallenges(): ChallengeStore {
    const rows = new Map<string, string>()
    return {
        async mint(c, boundTo) {
            rows.set(c, boundTo)
        },
        async consume(c) {
            const v = rows.get(c)
            if (v === undefined) return null
            rows.delete(c)
            return v
        },
    }
}

/** Only the parts `authenticateOwner` touches. */
function stubStore(registration: RegistrationFields | null): PMRStore {
    return {
        load: async () => registration,
    } as unknown as PMRStore
}

function deps(opts: {
    challenges: ChallengeStore
    registrations: Map<string, RegistrationFields>
}) {
    return {
        challenges: opts.challenges,
        resolveLocator: async (did: string): Promise<Locator | null> =>
            opts.registrations.has(did) ? `loc:${did}` : null,
        store: (locator: Locator) =>
            stubStore(opts.registrations.get(locator.slice("loc:".length)) ?? null),
        nowSeconds: T0,
    }
}

async function scenario(opts?: { registerAlice?: boolean }) {
    const secretKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(secretKey)
    const challenges = memoryChallenges()
    const registrations = new Map<string, RegistrationFields>()
    if (opts?.registerAlice !== false) {
        registrations.set(ALICE, {
            did: ALICE,
            anchorKey: publicKey,
            lastActive: T0,
        })
    }
    return { secretKey, publicKey, challenges, registrations }
}

function signed(
    secretKey: Uint8Array,
    nonce: string,
    url = URL_,
    method = "GET"
) {
    const parts = signRequest({ method, url, nonce, keyid: "thumb", secretKey })
    return new Request(url, { method, headers: parts.headers })
}

describe("owner authentication needs both halves", () => {
    it("accepts a signed request whose challenge names the signer", async () => {
        const s = await scenario()
        await s.challenges.mint("chal", encodeBinding({ realm: "anchor", subject: ALICE }), T0 + 600)

        const outcome = await authenticateOwner(
            signed(s.secretKey, "chal"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(true)
        if (!outcome.authenticated) throw new Error("unreachable")
        expect(outcome.did).toBe(ALICE)
    })

    it("refuses when the challenge names someone else — a stolen challenge is useless", async () => {
        // The binding decides WHICH key to check. Redeeming Mallory's
        // challenge means verifying against Mallory's registration, which
        // Alice's signature will not satisfy.
        const s = await scenario()
        s.registrations.set(MALLORY, {
            did: MALLORY,
            anchorKey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
            lastActive: T0,
        })
        await s.challenges.mint(
            "chal",
            encodeBinding({ realm: "anchor", subject: MALLORY }),
            T0 + 600
        )

        // Alice signs, but the challenge is bound to Mallory.
        const outcome = await authenticateOwner(
            signed(s.secretKey, "chal"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })

    it("refuses a valid signature with no challenge", async () => {
        const s = await scenario()
        const outcome = await authenticateOwner(
            signed(s.secretKey, "never-minted"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })

    it("refuses a valid challenge with a signature from the wrong key", async () => {
        const s = await scenario()
        await s.challenges.mint("chal", encodeBinding({ realm: "anchor", subject: ALICE }), T0 + 600)

        const impostor = ed25519.utils.randomSecretKey()
        const outcome = await authenticateOwner(
            signed(impostor, "chal"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })

    it("refuses an unsigned request outright", async () => {
        const s = await scenario()
        const outcome = await authenticateOwner(
            new Request(URL_, { method: "GET" }),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })

    it("refuses a registration-realm challenge on an owner endpoint", async () => {
        const s = await scenario()
        await s.challenges.mint(
            "chal",
            encodeBinding({ realm: "registration", subject: ALICE }),
            T0 + 600
        )
        const outcome = await authenticateOwner(
            signed(s.secretKey, "chal"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })

    it("refuses when the DID has no registration here", async () => {
        const s = await scenario({ registerAlice: false })
        await s.challenges.mint("chal", encodeBinding({ realm: "anchor", subject: ALICE }), T0 + 600)
        const outcome = await authenticateOwner(
            signed(s.secretKey, "chal"),
            null,
            deps(s)
        )
        expect(outcome.authenticated).toBe(false)
    })
})

describe("the challenge is spent before verification", () => {
    it("a failed verification still burns the challenge", async () => {
        // Deliberate: an attempt cannot be retried into a different
        // verdict. Verifying first and redeeming after would let an
        // attacker probe signatures against one challenge indefinitely.
        const s = await scenario()
        await s.challenges.mint("chal", encodeBinding({ realm: "anchor", subject: ALICE }), T0 + 600)

        const impostor = ed25519.utils.randomSecretKey()
        expect(
            (await authenticateOwner(signed(impostor, "chal"), null, deps(s)))
                .authenticated
        ).toBe(false)

        // Even the rightful holder cannot now use it.
        expect(
            (await authenticateOwner(signed(s.secretKey, "chal"), null, deps(s)))
                .authenticated
        ).toBe(false)
    })
})

describe("a captured owner request does not replay elsewhere", () => {
    it("refuses when replayed against a different path", async () => {
        const s = await scenario()
        await s.challenges.mint("chal", encodeBinding({ realm: "anchor", subject: ALICE }), T0 + 600)
        const request = signed(s.secretKey, "chal")

        // Same signature, different route — @path is covered.
        const replayed = new Request(
            "https://relay.example/pmr/v1/blocks",
            { method: "GET", headers: request.headers }
        )
        const outcome = await authenticateOwner(replayed, null, deps(s))
        expect(outcome.authenticated).toBe(false)
    })
})
