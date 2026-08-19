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
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
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

function signedRequest(
    url: string,
    method: string,
    secretKey: Uint8Array,
    nonce: string,
    body?: Uint8Array
) {
    const parts = signRequest({ method, url, nonce, keyid: "t", secretKey, body })
    return new Request(url, {
        method,
        headers: parts.headers,
        ...(body !== undefined ? { body } : {}),
    })
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

    it("re-registering without a push subscription does not drop an existing one", async () => {
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
            pushSubscription: {
                endpoint: "https://push.example/sub/abc",
                contentKey: new Uint8Array(32).fill(7),
                keyId: 3,
            },
        })

        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        expect(w.rows.get(DID)!.pushSubscription?.endpoint).toBe(
            "https://push.example/sub/abc"
        )
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

describe("the Web Push subscription", () => {
    function subscriptionBody(fields: Record<string, CoseValue>): Uint8Array {
        return encodeCose(new Map<string, CoseValue>(Object.entries(fields)))
    }

    it("a well-formed subscription is decoded and stored in full", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)
        const contentKey = new Uint8Array(32).fill(9)

        const body = subscriptionBody({
            pse: "https://push.example/sub/xyz",
            psk: contentKey,
            psi: 42,
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(201)
        expect(w.rows.get(DID)!.pushSubscription).toEqual({
            endpoint: "https://push.example/sub/xyz",
            contentKey,
            keyId: 42,
        })
    })

    it("a subscription missing psk answers 400 and stores nothing", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const body = subscriptionBody({
            pse: "https://push.example/sub/xyz",
            psi: 42,
            // psk omitted — present-but-incomplete, not absent-entirely.
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(400)
        expect(w.rows.has(DID)).toBe(false)
    })

    it("a contentKey of the wrong length answers 400", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const body = subscriptionBody({
            pse: "https://push.example/sub/xyz",
            psk: new Uint8Array(31),
            psi: 42,
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(400)
    })

    it("a keyId outside 0..255 answers 400", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const body = subscriptionBody({
            pse: "https://push.example/sub/xyz",
            psk: new Uint8Array(32),
            psi: 300,
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(400)
    })

    it("a non-https endpoint answers 400", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const body = subscriptionBody({
            pse: "http://push.example/sub/xyz",
            psk: new Uint8Array(32),
            psi: 1,
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(400)
        expect(w.rows.has(DID)).toBe(false)
    })

    it("an unparseable endpoint answers 400", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const body = subscriptionBody({
            pse: "not a url at all",
            psk: new Uint8Array(32),
            psi: 1,
        })
        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID), body),
            deps(w)
        )
        expect(response.status).toBe(400)
    })

    it("no subscription fields at all is a normal registration, not an error", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        const response = await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        expect(response.status).toBe(201)
        expect(w.rows.get(DID)!.pushSubscription).toBeUndefined()
    })

    it("the read endpoint reports ps: true and never echoes the endpoint or content key", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)
        const contentKey = new Uint8Array(32).fill(9)

        await handleRegistrationCreate(
            signedRequest(
                CREATE_URL,
                "POST",
                key,
                await challengeFor(w, DID),
                subscriptionBody({
                    pse: "https://push.example/sub/xyz",
                    psk: contentKey,
                    psi: 42,
                })
            ),
            deps(w)
        )

        const response = await handleRegistrationRead(
            signedRequest(READ_URL, "GET", key, await challengeFor(w, DID)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        expect(map.get("ps")).toBe(true)
        expect(map.has("pse")).toBe(false)
        expect(map.has("psk")).toBe(false)
        expect(map.has("psi")).toBe(false)
    })

    it("the read endpoint reports ps: false when no subscription exists", async () => {
        const w = world()
        const key = ed25519.utils.randomSecretKey()
        declaredKey = ed25519.getPublicKey(key)

        await handleRegistrationCreate(
            signedRequest(CREATE_URL, "POST", key, await challengeFor(w, DID)),
            deps(w)
        )
        const response = await handleRegistrationRead(
            signedRequest(READ_URL, "GET", key, await challengeFor(w, DID)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        expect(map.get("ps")).toBe(false)
    })
})
