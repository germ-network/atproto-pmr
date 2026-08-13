/**
 * Registration create, and the property that makes it a recovery path.
 *
 * Every owner endpoint verifies against the **stored** anchor key. So the
 * moment an owner rotates the key in their declaration, nothing they sign
 * matches — including a `DELETE` to clean up — while mail keeps arriving.
 * That is a permanent lockout unless something writes the new key through.
 *
 * Re-registration is that something, and these tests are the ones whose
 * absence let the lockout ship.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodeBinding } from "../src/challenge"
import { encodeOkpEd25519Key, parseOkpEd25519Key } from "../src/cose/key"
import { signRequest } from "../src/http-sig/sign"
import {
    handleRegistrationCreate,
    handleRegistrationRead,
} from "../src/owner/endpoints"
import type {
    ChallengeStore,
    Directory,
    Locator,
    PMRStore,
    RegistrationFields,
} from "../src/storage"

const T0 = 1_760_000_000
const DID = "did:plc:rotator0000000000000"
const CREATE_URL = "https://relay.example/pmr/v1/registrations"
const READ_URL = "https://relay.example/pmr/v1/registration"

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

/**
 * An in-memory world: a directory that is idempotent-on-DID exactly as the
 * real one is (returning the existing locator, untouched), and a store
 * whose `update` merges. If the endpoint stopped writing the key through,
 * this fixture would keep the stale one — which is the bug.
 */
function world() {
    const rows = new Map<string, RegistrationFields>()
    const challenges = memoryChallenges()

    const directory: Directory = {
        async resolve(did) {
            return rows.has(did) ? `loc:${did}` : null
        },
        async resolveAddress() {
            return null
        },
        async create(did, registration) {
            if (!rows.has(did)) rows.set(did, registration)
            return `loc:${did}`
        },
        async delete(did) {
            rows.delete(did)
        },
    }

    const store = (locator: Locator): PMRStore => {
        const did = locator.slice("loc:".length)
        return {
            load: async () => rows.get(did) ?? null,
            update: async (fields) => {
                rows.set(did, { ...rows.get(did), ...fields } as RegistrationFields)
            },
        } as unknown as PMRStore
    }

    return { rows, challenges, directory, store }
}

/** The declared key, which the owner controls and can rotate. */
let declaredKey: Uint8Array = new Uint8Array(32)

function deps(w: ReturnType<typeof world>) {
    return {
        challenges: w.challenges,
        directory: w.directory,
        resolveLocator: (did: string) => w.directory.resolve(did),
        store: w.store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        resolveAnchorKey: async () => declaredKey,
    }
}

async function challengeFor(w: ReturnType<typeof world>, did: string) {
    const c = `chal-${Math.random().toString(36).slice(2)}`
    await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    return c
}

function signedRequest(url: string, method: string, secretKey: Uint8Array, nonce: string) {
    const parts = signRequest({ method, url, nonce, keyid: "t", secretKey })
    return new Request(url, { method, headers: parts.headers })
}

describe("anchor-key rotation does not lock the owner out", () => {
    it("re-registration writes the freshly-verified key through", async () => {
        const w = world()
        const oldKey = ed25519.utils.randomSecretKey()
        const newKey = ed25519.utils.randomSecretKey()

        // Register under the old declared key.
        declaredKey = ed25519.getPublicKey(oldKey)
        const created = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", oldKey, await challengeFor(w, DID)),
            deps(w)
        )
        expect(created.status).toBe(201)
        expect(
            (
                await handleRegistrationRead(
                    signedRequest(READ_URL, "GET", oldKey, await challengeFor(w, DID)),
                    deps(w)
                )
            ).status
        ).toBe(200)

        // The owner rotates. The declaration now carries the new key, so the
        // new key does NOT match what is stored — this is the lockout.
        declaredKey = ed25519.getPublicKey(newKey)
        expect(
            (
                await handleRegistrationRead(
                    signedRequest(READ_URL, "GET", newKey, await challengeFor(w, DID)),
                    deps(w)
                )
            ).status
        ).toBe(401)

        // Recovery: re-register. Authentication here runs against the
        // CURRENT declaration, so the new key verifies, and the endpoint
        // writes it through rather than returning the stale registration.
        const again = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", newKey, await challengeFor(w, DID)),
            deps(w)
        )
        expect(again.status).toBe(201)

        // Unlocked.
        expect(
            (
                await handleRegistrationRead(
                    signedRequest(READ_URL, "GET", newKey, await challengeFor(w, DID)),
                    deps(w)
                )
            ).status
        ).toBe(200)

        // And the stored key is the new one, self-describing as required.
        const stored = w.rows.get(DID)!
        expect([...parseOkpEd25519Key(stored.anchorKey).x]).toEqual([
            ...ed25519.getPublicKey(newKey),
        ])
    })

    it("the old key stops working after rotation — this is a replace, not an add", async () => {
        const w = world()
        const oldKey = ed25519.utils.randomSecretKey()
        const newKey = ed25519.utils.randomSecretKey()

        declaredKey = ed25519.getPublicKey(oldKey)
        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", oldKey, await challengeFor(w, DID)),
            deps(w)
        )

        declaredKey = ed25519.getPublicKey(newKey)
        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", newKey, await challengeFor(w, DID)),
            deps(w)
        )

        // A rotation that left the old key working would mean a compromised
        // key stays valid forever, which is the thing rotation exists to end.
        expect(
            (
                await handleRegistrationRead(
                    signedRequest(READ_URL, "GET", oldKey, await challengeFor(w, DID)),
                    deps(w)
                )
            ).status
        ).toBe(401)
    })

    it("cannot be driven by someone who does not hold the declared key", async () => {
        // The write-through is only safe because authentication ran against
        // the CURRENT declaration first. An attacker signing with their own
        // key never reaches it.
        const w = world()
        const owner = ed25519.utils.randomSecretKey()
        const attacker = ed25519.utils.randomSecretKey()

        declaredKey = ed25519.getPublicKey(owner)
        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", owner, await challengeFor(w, DID)),
            deps(w)
        )

        const hijack = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", attacker, await challengeFor(w, DID)),
            deps(w)
        )
        expect(hijack.status).toBe(401)

        // The owner's key is untouched.
        const stored = w.rows.get(DID)!
        expect([...parseOkpEd25519Key(stored.anchorKey).x]).toEqual([
            ...ed25519.getPublicKey(owner),
        ])
    })

    it("re-registering without a push grant does not drop an existing one", async () => {
        // Refreshing a key must not silently break push delivery.
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        w.rows.set(DID, {
            ...w.rows.get(DID)!,
            pushGrant: { id: "pg", key: new Uint8Array([1, 2]), expiry: T0 + 999 },
        })

        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        expect(w.rows.get(DID)!.pushGrant?.id).toBe("pg")
    })

    it("stores the anchor key as a COSE_Key blob, never raw bytes", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        const stored = w.rows.get(DID)!.anchorKey
        // A raw key would be exactly 32 bytes; the COSE_Key wrapper is longer
        // and parses, which is what keeps a new algorithm from being a
        // schema migration.
        expect(stored.byteLength).toBeGreaterThan(32)
        expect(parseOkpEd25519Key(stored).x.byteLength).toBe(32)
    })
})
