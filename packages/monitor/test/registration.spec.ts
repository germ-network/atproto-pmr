/**
 * The monitor registration surface's security core.
 *
 * Unlike the PMR's registration (`core/test/registration.spec.ts`), a
 * mutation of an EXISTING registration here must verify against the
 * STORED anchor key, never the currently-declared one — see
 * `registration-endpoint.ts`'s module comment for why. These tests are the
 * ones whose absence would let a naive copy of the PMR's write-through
 * ship instead.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import {
    decodeCoseMap,
    encodeBinding,
    encodeCose,
    encodeOkpEd25519Key,
    parseOkpEd25519Key,
    signRequest,
    type ChallengeStore,
    type CoseValue,
} from "@germ-network/atproto-pmr-core"
import {
    handleMonitorRegistrationCreate,
    handleMonitorRegistrationDelete,
} from "../src/registration-endpoint"
import type { MonitorRegistration, MonitorRegistrationStore } from "../src/registration"

const T0 = 1_760_000_000
const DID_A = "did:plc:alice00000000000000"
const DID_B = "did:plc:bob0000000000000000"
const URL_CREATE = "https://relay.example/monitor/v1/registration"
const URL_DELETE = "https://relay.example/monitor/v1/registration"

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

function memoryStore(): MonitorRegistrationStore & {
    rows: Map<string, MonitorRegistration>
} {
    const rows = new Map<string, MonitorRegistration>()
    return {
        rows,
        async load(did) {
            return rows.get(did) ?? null
        },
        async put(reg) {
            rows.set(reg.did, reg)
        },
        async delete(did) {
            rows.delete(did)
        },
    }
}

function world() {
    const challenges = memoryChallenges()
    const registrations = memoryStore()
    /** DID -> currently-declared key. The PDS controls this and can rotate it. */
    const declared = new Map<string, Uint8Array>()
    return { challenges, registrations, declared }
}

function deps(w: ReturnType<typeof world>) {
    return {
        challenges: w.challenges,
        registrations: w.registrations,
        resolveAnchorKey: async (did: string) => w.declared.get(did) ?? null,
        nowSeconds: T0,
    }
}

async function challengeFor(w: ReturnType<typeof world>, did: string) {
    const c = `chal-${Math.random().toString(36).slice(2)}`
    await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    return c
}

function subscriptionBody(overrides: Partial<{
    pse: unknown
    psk: unknown
    psi: unknown
}> = {}): Uint8Array {
    const map = new Map<string, CoseValue>()
    map.set("pse", "pse" in overrides ? (overrides.pse as CoseValue) : "https://push.example/sub/1")
    map.set("psk", "psk" in overrides ? (overrides.psk as CoseValue) : new Uint8Array(32).fill(7))
    map.set("psi", "psi" in overrides ? (overrides.psi as CoseValue) : 3)
    return encodeCose(map)
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
        ...(body !== undefined ? { body: body as BodyInit } : {}),
    })
}

describe("create — no existing registration", () => {
    it("verifies against the DID's currently-declared key and stores it as a COSE_Key blob", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        const publicKey = ed25519.getPublicKey(secretKey)
        w.declared.set(DID_A, publicKey)

        const nonce = await challengeFor(w, DID_A)
        const body = subscriptionBody()
        const req = signedRequest(URL_CREATE, "POST", secretKey, nonce, body)

        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(201)

        const stored = w.registrations.rows.get(DID_A)
        expect(stored).toBeDefined()
        expect(parseOkpEd25519Key(stored!.anchorKey).x).toEqual(publicKey)
        expect(stored!.pushSubscription).toEqual({
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(7),
            keyId: 3,
        })
    })

    it("A registering with a challenge bound to B stores nothing under B, and B is 401", async () => {
        const w = world()
        const secretA = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretA))
        w.declared.set(DID_B, ed25519.getPublicKey(ed25519.utils.randomSecretKey()))

        // A challenge minted for B, but signed by A's key.
        const nonce = await challengeFor(w, DID_B)
        const req = signedRequest(URL_CREATE, "POST", secretA, nonce, subscriptionBody())

        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(401)
        expect(w.registrations.rows.has(DID_B)).toBe(false)
        expect(w.registrations.rows.has(DID_A)).toBe(false)
    })

    it("a body-supplied DID field is ignored — the registration lands under the challenge's subject", async () => {
        const w = world()
        const secretA = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretA))

        const nonce = await challengeFor(w, DID_A)
        const map = new Map<string, CoseValue>([
            ["pse", "https://push.example/sub/1"],
            ["psk", new Uint8Array(32).fill(1)],
            ["psi", 0],
            ["did", DID_B],
        ])
        const body = encodeCose(map)
        const req = signedRequest(URL_CREATE, "POST", secretA, nonce, body)

        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(201)
        expect(w.registrations.rows.has(DID_A)).toBe(true)
        expect(w.registrations.rows.has(DID_B)).toBe(false)
    })

    it("an unresolvable declared key (unknown DID) is 401", async () => {
        const w = world()
        const secretA = ed25519.utils.randomSecretKey()
        // w.declared has nothing for DID_A.
        const nonce = await challengeFor(w, DID_A)
        const req = signedRequest(URL_CREATE, "POST", secretA, nonce, subscriptionBody())

        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(401)
    })
})

describe("a PDS key-swap cannot rebind or delete an existing registration", () => {
    async function registered(w: ReturnType<typeof world>) {
        const oldKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(oldKey))
        const nonce = await challengeFor(w, DID_A)
        const res = await handleMonitorRegistrationCreate(
            signedRequest(URL_CREATE, "POST", oldKey, nonce, subscriptionBody()),
            deps(w)
        )
        expect(res.status).toBe(201)
        return oldKey
    }

    it("POST signed with the newly-declared key, after a PDS-published rotation, is 401 and leaves the registration unchanged", async () => {
        const w = world()
        const oldKey = await registered(w)
        const before = w.registrations.rows.get(DID_A)

        // The hostile/compromised PDS swaps the declaration to a new key
        // the attacker controls, then tries to use it immediately.
        const evilKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(evilKey))

        const nonce = await challengeFor(w, DID_A)
        const attempt = subscriptionBody({ pse: "https://attacker.example/sub" })
        const res = await handleMonitorRegistrationCreate(
            signedRequest(URL_CREATE, "POST", evilKey, nonce, attempt),
            deps(w)
        )

        expect(res.status).toBe(401)
        expect(w.registrations.rows.get(DID_A)).toEqual(before)
        void oldKey
    })

    it("the same, for DELETE", async () => {
        const w = world()
        await registered(w)

        const evilKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(evilKey))

        const nonce = await challengeFor(w, DID_A)
        const res = await handleMonitorRegistrationDelete(
            signedRequest(URL_DELETE, "DELETE", evilKey, nonce),
            deps(w)
        )

        expect(res.status).toBe(401)
        expect(w.registrations.rows.has(DID_A)).toBe(true)
    })

    it("a rebind signed with the STORED key succeeds and replaces the subscription, but not the anchor key", async () => {
        const w = world()
        const oldKey = await registered(w)
        const before = w.registrations.rows.get(DID_A)!

        // The declaration rotates (as it may for unrelated reasons), but
        // the request is signed with the key this registration still
        // trusts — the legitimate "just changing my push endpoint" case.
        w.declared.set(DID_A, ed25519.getPublicKey(ed25519.utils.randomSecretKey()))

        const nonce = await challengeFor(w, DID_A)
        const newBody = subscriptionBody({
            pse: "https://push.example/sub/NEW",
            psk: new Uint8Array(32).fill(9),
            psi: 200,
        })
        const res = await handleMonitorRegistrationCreate(
            signedRequest(URL_CREATE, "POST", oldKey, nonce, newBody),
            deps(w)
        )

        expect(res.status).toBe(201)
        const after = w.registrations.rows.get(DID_A)!
        expect(after.anchorKey).toEqual(before.anchorKey)
        expect(after.pushSubscription).toEqual({
            endpoint: "https://push.example/sub/NEW",
            contentKey: new Uint8Array(32).fill(9),
            keyId: 200,
        })
    })

    it("a rebind never consults resolveAnchorKey at all — proven by making it throw", async () => {
        // The prior test leaves `resolveAnchorKey` resolvable to a rotated
        // key, which a mutant that calls-but-ignores it would still pass.
        // Making it throw is what actually pins "the existing-registration
        // path never reaches it" — if it were called, this call would
        // reject before any assertion ran.
        const w = world()
        const oldKey = await registered(w)
        const throwingDeps = {
            ...deps(w),
            resolveAnchorKey: async (): Promise<Uint8Array | null> => {
                throw new Error("resolveAnchorKey must not be called on a rebind")
            },
        }

        const nonce = await challengeFor(w, DID_A)
        const res = await handleMonitorRegistrationCreate(
            signedRequest(URL_CREATE, "POST", oldKey, nonce, subscriptionBody()),
            throwingDeps
        )
        expect(res.status).toBe(201)
    })

    it("DELETE signed with the stored key succeeds", async () => {
        const w = world()
        const oldKey = await registered(w)
        const nonce = await challengeFor(w, DID_A)
        const res = await handleMonitorRegistrationDelete(
            signedRequest(URL_DELETE, "DELETE", oldKey, nonce),
            deps(w)
        )
        expect(res.status).toBe(204)
        expect(w.registrations.rows.has(DID_A)).toBe(false)
    })

    it("a second DELETE, after the first, is 401 (no stored key left to verify against) — not a distinguishable error", async () => {
        const w = world()
        const oldKey = await registered(w)
        const nonce1 = await challengeFor(w, DID_A)
        const first = await handleMonitorRegistrationDelete(
            signedRequest(URL_DELETE, "DELETE", oldKey, nonce1),
            deps(w)
        )
        expect(first.status).toBe(204)

        const nonce2 = await challengeFor(w, DID_A)
        const second = await handleMonitorRegistrationDelete(
            signedRequest(URL_DELETE, "DELETE", oldKey, nonce2),
            deps(w)
        )
        expect(second.status).toBe(401)
        const secondBody = await second.arrayBuffer()
        expect(secondBody.byteLength).toBe(0)
    })
})

describe("body validation — 400, and nothing stored", () => {
    async function attempt(w: ReturnType<typeof world>, secretKey: Uint8Array, body: Uint8Array) {
        const nonce = await challengeFor(w, DID_A)
        return handleMonitorRegistrationCreate(
            signedRequest(URL_CREATE, "POST", secretKey, nonce, body),
            deps(w)
        )
    }

    it("missing psk", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const map = new Map<string, CoseValue>([
            ["pse", "https://push.example/sub/1"],
            ["psi", 0],
        ])
        const res = await attempt(w, secretKey, encodeCose(map))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("a 31-byte psk", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const res = await attempt(w, secretKey, subscriptionBody({ psk: new Uint8Array(31) }))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("psi out of range (300)", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const res = await attempt(w, secretKey, subscriptionBody({ psi: 300 }))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("a non-https endpoint", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const res = await attempt(w, secretKey, subscriptionBody({ pse: "http://push.example/sub/1" }))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("an unparseable endpoint", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const res = await attempt(w, secretKey, subscriptionBody({ pse: "not a url" }))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("an empty body (subscription is required, unlike the PMR's)", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const res = await attempt(w, secretKey, new Uint8Array(0))
        expect(res.status).toBe(400)
        expect(w.registrations.rows.size).toBe(0)
    })

    it("a body over the size cap is 413, before any auth or decode", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))
        const oversized = new Uint8Array(17 * 1024)
        const res = await attempt(w, secretKey, oversized)
        expect(res.status).toBe(413)
        expect(w.registrations.rows.size).toBe(0)
    })
})

describe("realm isolation", () => {
    it("a challenge minted for grantPut does not verify at the monitor registration endpoint", async () => {
        const w = world()
        const secretKey = ed25519.utils.randomSecretKey()
        w.declared.set(DID_A, ed25519.getPublicKey(secretKey))

        const c = "chal-wrong-realm"
        await w.challenges.mint(c, encodeBinding({ realm: "grantPut", subject: DID_A }), T0 + 600)

        const req = signedRequest(URL_CREATE, "POST", secretKey, c, subscriptionBody())
        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(401)
    })
})

describe("every failure is a bare 401 with an empty body", () => {
    it("unsigned create", async () => {
        const w = world()
        const req = new Request(URL_CREATE, { method: "POST", body: subscriptionBody() as BodyInit })
        const res = await handleMonitorRegistrationCreate(req, deps(w))
        expect(res.status).toBe(401)
        expect((await res.arrayBuffer()).byteLength).toBe(0)
    })

    it("unsigned delete", async () => {
        const w = world()
        const req = new Request(URL_DELETE, { method: "DELETE" })
        const res = await handleMonitorRegistrationDelete(req, deps(w))
        expect(res.status).toBe(401)
        expect((await res.arrayBuffer()).byteLength).toBe(0)
    })
})

// Sanity check that `decodeCoseMap` round-trips what `subscriptionBody`
// builds — guards the fixture itself, not the endpoint.
describe("fixture sanity", () => {
    it("subscriptionBody decodes to the expected map", () => {
        const map = decodeCoseMap(subscriptionBody())
        expect(map.get("pse")).toBe("https://push.example/sub/1")
        expect(map.get("psi")).toBe(3)
    })
})
