/**
 * Deregistration tombstones the anchor: its puts are dropped, it never
 * registers again, and another anchor of the same DID still can.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    encodeBinding,
    handleRegistrationCreate,
    signRequest,
    thumbprintOkpEd25519,
    type ChallengeStore,
    type Locator,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory, pmrStore } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

const testEnv = env as unknown as PMREnv<PMRObject>
const T0 = Math.floor(Date.now() / 1000)
const CREATE_URL = "https://relay.example/pmr/v1/registrations"

let didCounter = 0
const freshDID = () => `did:plc:dereg-test-${(didCounter += 1)}`

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

async function register(
    did: string,
    secretKey: Uint8Array,
    directory: KVDirectory
): Promise<Response> {
    const challenges = memoryChallenges()
    const nonce = `chal-${Math.random().toString(36).slice(2)}`
    await challenges.mint(nonce, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    const parts = signRequest({ method: "POST", url: CREATE_URL, nonce, keyid: "t", secretKey })
    return handleRegistrationCreate(
        new Request(CREATE_URL, { method: "POST", headers: parts.headers }),
        {
            challenges,
            resolveLocator: (d: string) => directory.resolve(d),
            store: (locator: Locator) => pmrStore(locator, testEnv),
            directory,
            discardWindowSeconds: 3600,
            nowSeconds: T0,
            resolveAnchorKey: async () => ed25519.getPublicKey(secretKey),
        }
    )
}

const thumb = (secretKey: Uint8Array) =>
    thumbprintOkpEd25519({ x: ed25519.getPublicKey(secretKey) })

describe("deregistration", () => {
    it("destroys the registration's storage", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key = ed25519.utils.randomSecretKey()
        expect((await register(did, key, directory)).status).toBe(201)
        const locator = (await directory.resolve(did))!
        await directory.deregister(did, thumb(key))
        expect(await pmrStore(locator, testEnv).load()).toBeNull()
    })

    it("a put to the deregistered DID finds no registration to store in", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        await directory.deregister(did, thumb(key))
        expect(await directory.resolve(did)).toBeNull()
        expect((await directory.registrations(did, T0)).active).toBeNull()
    })

    it("the same anchor cannot register again", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        await directory.deregister(did, thumb(key))
        expect((await register(did, key, directory)).status).toBe(401)
        expect(await directory.resolve(did)).toBeNull()
    })

    it("a thumbprint that is not the active anchor's deregisters nothing", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        const locator = await directory.resolve(did)
        await directory.deregister(did, thumb(ed25519.utils.randomSecretKey()))
        expect(await directory.resolve(did)).toBe(locator)
        expect(await pmrStore(locator!, testEnv).load()).not.toBeNull()
    })

    it("a different anchor of the same DID can register", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        await directory.deregister(did, thumb(key))
        expect((await register(did, ed25519.utils.randomSecretKey(), directory)).status).toBe(201)
        expect(await directory.resolve(did)).not.toBeNull()
    })

    it("leaves the DID's inactive registrations as they were", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const key1 = ed25519.utils.randomSecretKey()
        const key2 = ed25519.utils.randomSecretKey()
        await register(did, key1, directory)
        const first = (await directory.resolve(did))!
        await register(did, key2, directory)
        await directory.deregister(did, thumb(key2))

        const set = await directory.registrations(did, T0)
        expect(set.active).toBeNull()
        expect(set.inactive.map((e) => e.locator)).toEqual([first])
        expect(await pmrStore(first, testEnv).load()).not.toBeNull()
    })
})
