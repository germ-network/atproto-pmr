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
import { describe, expect, it } from "vitest"
import {
    asPairMailboxKey,
    encodeBinding,
    handleRegistrationCreate,
    parseOkpEd25519Key,
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
        discardWindowSeconds: 3600,
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
