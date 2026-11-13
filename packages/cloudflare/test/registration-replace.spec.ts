/**
 * `handleRegistrationCreate`'s deactivate + replace path (`owner/endpoints.ts`,
 * GER-2448/GER-2449), exercised black-box against a REAL `KVDirectory` and a
 * REAL Durable Object — no network, no mocked storage. Where
 * `packages/core/test/registration.spec.ts` proves the directory's `delete`
 * call happens (or doesn't) via an in-memory spy, this proves what actually
 * matters operationally: a different-key re-registration lands on a genuinely
 * fresh, empty Durable Object, and a same-key re-registration does not.
 *
 * Also the first test in this package to reach `KVDirectory.create`'s DO-RPC
 * path (`this.env.pmrs.get(id).update(...)`) through the stub, rather than
 * `runInDurableObject` — every other `cloudflare` test drives the object
 * in-process via `helpers.ts`'s `inPMR`.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    binaryToBase64URL,
    encodeCose,
    type RegistrationExtension,
    asPairMailboxKey,
    encodeBinding,
    handleRegistrationCreate,
    handleRegistrationDelete,
    handleRegistrationRead,
    decodeCoseMap,
    parseOkpEd25519Key,
    thumbprintOkpEd25519,
    signRequest,
    type ChallengeStore,
    type Locator,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory, pmrStore } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

const testEnv = env as unknown as PMREnv<PMRObject>

const T0 = 1_760_000_000
const CREATE_URL = "https://relay.example/pmr/v1/registrations"

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

let didCounter = 0
/** A fresh DID per test — the KV directory row persists across tests in the same isolate. */
function freshDID(): string {
    didCounter += 1
    return `did:plc:replace-test-${didCounter}`
}

let nonceCounter = 0
function freshNonce(): Uint8Array {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}

async function challengeFor(challenges: ChallengeStore, did: string): Promise<string> {
    const c = `chal-${Math.random().toString(36).slice(2)}`
    await challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    return c
}

function signedRequest(secretKey: Uint8Array, nonce: string): Request {
    const parts = signRequest({
        method: "POST",
        url: CREATE_URL,
        nonce,
        keyid: "t",
        secretKey,
    })
    return new Request(CREATE_URL, { method: "POST", headers: parts.headers })
}

function deps(challenges: ChallengeStore, resolveAnchorKey: () => Promise<Uint8Array | null>) {
    const directory = new KVDirectory(testEnv)
    return {
        challenges,
        resolveLocator: (did: string) => directory.resolve(did),
        store: (locator: Locator) => pmrStore(locator, testEnv),
        directory,
        nowSeconds: T0,
        resolveAnchorKey,
    }
}

/** Registers `did` under `secretKey` and returns the resulting locator. */
async function register(
    did: string,
    secretKey: Uint8Array,
    challenges: ChallengeStore,
    directory: KVDirectory
): Promise<Locator> {
    const declaredKey = ed25519.getPublicKey(secretKey)
    const response = await handleRegistrationCreate(
        signedRequest(secretKey, await challengeFor(challenges, did)),
        deps(challenges, async () => declaredKey)
    )
    expect(response.status).toBe(201)
    const locator = await directory.resolve(did)
    expect(locator).not.toBeNull()
    return locator!
}

describe("a different declared key deactivates and replaces the prior registration", () => {
    it("lands on a fresh, empty Durable Object under the new key", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const keyA = ed25519.utils.randomSecretKey()
        const keyB = ed25519.utils.randomSecretKey()
        const sender = asPairMailboxKey("did:plc:some-sender")

        const L1 = await register(did, keyA, challenges, directory)
        const store1 = pmrStore(L1, testEnv)

        const appended = await store1.append(
            sender,
            { messageId: "m1", byteLength: 42 },
            freshNonce(),
            T0
        )
        expect(appended.outcome).toBe("appended")
        await store1.issueGrant("addr-under-test-A", new Uint8Array(32).fill(9), T0 + 3600)

        const L2 = await register(did, keyB, challenges, directory)
        expect(L2).not.toBe(L1)

        const store2 = pmrStore(L2, testEnv)
        const page = await store2.openMailboxes(null, 100)
        expect(page.entries).toEqual([])
        expect(await store2.listGrants()).toEqual([])

        const stored = await store2.load()
        expect([...parseOkpEd25519Key(stored!.anchorKey).x]).toEqual([
            ...ed25519.getPublicKey(keyB),
        ])

        // The OLD DO (L1) is torn down, not merely unreferenced: its
        // registration and mail are gone, not just orphaned.
        expect(await store1.load()).toBeNull()
        const oldPage = await store1.openMailboxes(null, 100)
        expect(oldPage.entries).toEqual([])
    })
})

describe("a same declared key stays an idempotent in-place refresh", () => {
    it("keeps the same Durable Object and its pending mail", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const key = ed25519.utils.randomSecretKey()
        const sender = asPairMailboxKey("did:plc:some-other-sender")

        const L1 = await register(did, key, challenges, directory)
        const store1 = pmrStore(L1, testEnv)
        const appended = await store1.append(
            sender,
            { messageId: "m1", byteLength: 42 },
            freshNonce(),
            T0
        )
        expect(appended.outcome).toBe("appended")

        const L2 = await register(did, key, challenges, directory)
        expect(L2).toBe(L1)

        const queue = await store1.list(sender, 100)
        expect(queue.map((r) => r.messageId)).toEqual(["m1"])
    })
})

describe("tombstones and monitor-retired registrations", () => {
    it("DELETE /registration tombstones the authenticated anchor", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, challenges, directory)

        const url = "https://relay.example/pmr/v1/registration"
        const nonce = await challengeFor(challenges, did)
        const parts = signRequest({ method: "DELETE", url, nonce, keyid: "t", secretKey: key })
        const response = await handleRegistrationDelete(
            new Request(url, { method: "DELETE", headers: parts.headers }),
            deps(challenges, async () => null)
        )
        expect(response.status).toBe(204)
        expect(await directory.resolve(did)).toBeNull()
        expect(
            await directory.isTombstoned(did, thumbprintOkpEd25519({ x: ed25519.getPublicKey(key) }))
        ).toBe(true)
    })

    it("a deregistered anchor cannot register again, another key of the DID can", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const key1 = ed25519.utils.randomSecretKey()
        const x1 = ed25519.getPublicKey(key1)
        await register(did, key1, challenges, directory)
        await directory.deregister(did, thumbprintOkpEd25519({ x: x1 }))

        const refused = await handleRegistrationCreate(
            signedRequest(key1, await challengeFor(challenges, did)),
            deps(challenges, async () => x1)
        )
        expect(refused.status).toBe(409)
        expect(await directory.resolve(did)).toBeNull()

        await register(did, ed25519.utils.randomSecretKey(), challenges, directory)
    })

    it("re-registering the anchor of a monitor-retired registration creates a fresh one", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const key = ed25519.utils.randomSecretKey()
        const retired = await register(did, key, challenges, directory)
        await directory.retire(did, retired)

        const fresh = await register(did, key, challenges, directory)
        expect(fresh).not.toBe(retired)
        expect(await pmrStore(retired, testEnv).load()).toBeNull()
        expect(await pmrStore(fresh, testEnv).load()).not.toBeNull()
    })
})

describe("registration read reports the pause", () => {
    it("st reads paused after an absent outcome and active after present; did and ps unchanged", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const key = ed25519.utils.randomSecretKey()
        const locator = await register(did, key, challenges, directory)
        const store = pmrStore(locator, testEnv)

        const read = async () => {
            const url = "https://relay.example/pmr/v1/registration"
            const nonce = await challengeFor(challenges, did)
            const parts = signRequest({ method: "GET", url, nonce, keyid: "t", secretKey: key })
            const response = await handleRegistrationRead(
                new Request(url, { method: "GET", headers: parts.headers }),
                deps(challenges, async () => null)
            )
            expect(response.status).toBe(200)
            return decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        }

        const before = await read()
        expect(before.get("st")).toBe("active")

        await store.applyDeclarationOutcome("absent", T0 + 10, "3k")
        const paused = await read()
        expect(paused.get("st")).toBe("paused")

        await store.applyDeclarationOutcome("present", T0 + 20, "3l")
        const after = await read()
        expect(after.get("st")).toBe("active")

        for (const map of [paused, after]) {
            expect(map.get("did")).toBe(did)
            expect(map.has("la")).toBe(false)
            expect(map.get("ps")).toBe(false)
        }
    })
})

describe("registration owner-activity touch (D-24)", () => {
    const DAY = 86_400
    let consoleSpies: ReturnType<typeof vi.spyOn>[]
    beforeEach(() => {
        consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => {})
        )
    })
    afterEach(() => {
        const output = consoleSpies.flatMap((spy) => spy.mock.calls)
        vi.restoreAllMocks()
        expect(output).toEqual([])
    })

    async function post(
        did: string,
        secretKey: Uint8Array,
        challenges: ChallengeStore,
        opts: {
            now: number
            body?: Uint8Array
            signer?: Uint8Array
            directory?: KVDirectory
            store?: (locator: Locator) => ReturnType<typeof pmrStore>
            extension?: RegistrationExtension
        }
    ): Promise<Response> {
        const nonce = await challengeFor(challenges, did)
        const parts = signRequest({
            method: "POST",
            url: CREATE_URL,
            nonce,
            keyid: "t",
            secretKey: opts.signer ?? secretKey,
            ...(opts.body !== undefined ? { body: opts.body } : {}),
        })
        const base = deps(challenges, async () => ed25519.getPublicKey(secretKey))
        return handleRegistrationCreate(
            new Request(CREATE_URL, { method: "POST", headers: parts.headers, body: opts.body }),
            {
                ...base,
                nowSeconds: opts.now,
                ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
                ...(opts.store !== undefined ? { store: opts.store } : {}),
                ...(opts.extension !== undefined ? { registrationExtension: opts.extension } : {}),
            }
        )
    }

    async function registeredAt(now: number, key = ed25519.utils.randomSecretKey()) {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        const challenges = memoryChallenges()
        const response = await post(did, key, challenges, { now })
        expect(response.status).toBe(201)
        const locator = (await directory.resolve(did))!
        const store = pmrStore(locator, testEnv)
        return { did, key, directory, challenges, locator, store, last: async () => (await store.load())?.lastActive }
    }

    const tombstone = (did: string, key: Uint8Array) =>
        testEnv.pmrDirectory.put(
            `tomb:${did}:${binaryToBase64URL(thumbprintOkpEd25519({ x: ed25519.getPublicKey(key) }))}`,
            "1"
        )

    it("same-key refresh on a new UTC day touches; the same day does not", async () => {
        const r = await registeredAt(T0)
        await post(r.did, r.key, r.challenges, { now: T0 + DAY })
        expect(await r.last()).toBe(T0 + DAY)
        await post(r.did, r.key, r.challenges, { now: T0 + DAY + 100 })
        expect(await r.last()).toBe(T0 + DAY)
    })

    it("refresh never moves lastActive backwards", async () => {
        const r = await registeredAt(T0)
        await post(r.did, r.key, r.challenges, { now: T0 - 5 * DAY })
        expect(await r.last()).toBe(T0)
    })

    it("same-key POST that 400s on push validation, or whose onCommitted throws, has still touched", async () => {
        const r = await registeredAt(T0)
        const malformed = encodeCose(new Map([["pse", "https://push.example/x"]]))
        const bad = await post(r.did, r.key, r.challenges, { now: T0 + DAY, body: malformed })
        expect(bad.status).toBe(400)
        expect(await r.last()).toBe(T0 + DAY)

        const r2 = await registeredAt(T0)
        const extension: RegistrationExtension = {
            parseCreateFields: () => ({}),
            onCommitted: async () => {
                throw new Error("commit failed")
            },
        }
        await expect(
            post(r2.did, r2.key, r2.challenges, { now: T0 + DAY, extension })
        ).rejects.toThrow("commit failed")
        expect(await r2.last()).toBe(T0 + DAY)
    })

    it("a same-key POST whose touchActive rejects still registers, silently", async () => {
        const r = await registeredAt(T0)
        const store = (locator: Locator) =>
            new Proxy(pmrStore(locator, testEnv), {
                get: (target, prop) =>
                    prop === "touchActive"
                        ? async () => {
                              throw new Error(r.did)
                          }
                        : (target as never as Record<string | symbol, unknown>)[prop],
            })
        const response = await post(r.did, r.key, r.challenges, { now: T0 + DAY, store })
        expect(response.status).toBe(201)
        expect(await r.last()).toBe(T0)
    })

    it("tombstoned anchor (409) and a bad signature never touch", async () => {
        const r = await registeredAt(T0)
        const stranger = ed25519.utils.randomSecretKey()
        const forged = await post(r.did, r.key, r.challenges, { now: T0 + DAY, signer: stranger })
        expect(forged.status).toBe(401)
        expect(await r.last()).toBe(T0)

        await tombstone(r.did, r.key)
        const refused = await post(r.did, r.key, r.challenges, { now: T0 + DAY })
        expect(refused.status).toBe(409)
        expect(await r.last()).toBe(T0)
    })

    it("different-key replace refused before the delete leaves the predecessor's lastActive untouched", async () => {
        const r = await registeredAt(T0)
        const keyB = ed25519.utils.randomSecretKey()
        await tombstone(r.did, keyB)
        const refused = await post(r.did, keyB, r.challenges, { now: T0 + DAY })
        expect(refused.status).toBe(409)
        expect(await r.directory.resolve(r.did)).toBe(r.locator)
        expect(await r.last()).toBe(T0)
    })

    it("a different-key POST refused after the touch point leaves the predecessor's lastActive untouched", async () => {
        const r = await registeredAt(T0)
        const keyB = ed25519.utils.randomSecretKey()
        const malformed = encodeCose(new Map([["pse", "https://push.example/x"]]))
        const refused = await post(r.did, keyB, r.challenges, { now: T0 + DAY, body: malformed })
        expect(refused.status).toBe(400)
        expect(await r.directory.resolve(r.did)).toBe(r.locator)
        expect(await r.last()).toBe(T0)
    })

    it("successful different-key replace sets lastActive only on the new incarnation", async () => {
        const r = await registeredAt(T0)
        const keyB = ed25519.utils.randomSecretKey()
        expect((await post(r.did, keyB, r.challenges, { now: T0 + DAY })).status).toBe(201)
        const fresh = (await r.directory.resolve(r.did))!
        expect(fresh).not.toBe(r.locator)
        expect((await pmrStore(fresh, testEnv).load())!.lastActive).toBe(T0 + DAY)
        expect(await r.store.load()).toBeNull()
    })

    it("a stale same-key refresh landing after a different-key replace touches nothing", async () => {
        const r = await registeredAt(T0)
        const keyB = ed25519.utils.randomSecretKey()
        await post(r.did, keyB, r.challenges, { now: T0 + 100 })
        const fresh = (await r.directory.resolve(r.did))!

        // The refresh resolved the DID before the replace landed.
        const stale = Object.create(r.directory) as KVDirectory
        const resolveNow = r.directory.resolve.bind(r.directory)
        let resolves = 0
        stale.resolve = async (did) => ((resolves += 1) === 1 ? r.locator : resolveNow(did))
        await post(r.did, r.key, r.challenges, { now: T0 + 2 * DAY, directory: stale })

        expect(await r.store.load()).toBeNull()
        expect((await pmrStore(fresh, testEnv).load())!.lastActive).toBe(T0 + 100)
    })

    it("a delayed request authenticated against the old incarnation neither touches the new one nor resurrects the old", async () => {
        const r = await registeredAt(T0)
        const oldBlob = (await r.store.load())!.anchorKey
        const keyB = ed25519.utils.randomSecretKey()
        await post(r.did, keyB, r.challenges, { now: T0 + 100 })
        const fresh = pmrStore((await r.directory.resolve(r.did))!, testEnv)

        await r.store.touchActive!(T0 + 3 * DAY, oldBlob)
        await fresh.touchActive!(T0 + 3 * DAY, oldBlob)

        expect(await r.store.load()).toBeNull()
        expect((await fresh.load())!.lastActive).toBe(T0 + 100)
    })

    it("a new incarnation keeps create's initial lastActive", async () => {
        const r = await registeredAt(T0 + 1_234)
        expect(await r.last()).toBe(T0 + 1_234)
    })
})
