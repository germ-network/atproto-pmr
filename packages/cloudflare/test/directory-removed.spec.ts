import { ed25519 } from "@noble/curves/ed25519.js"
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
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

class RecordingDirectory extends KVDirectory {
    removed: Array<{ did: string; locator: Locator }> = []
    resolvedDuring: Array<Locator | null> = []
    failWith: Error | undefined
    protected override async onRemoved(did: string, locator: Locator): Promise<void> {
        this.removed.push({ did, locator })
        this.resolvedDuring.push(await this.resolve(did))
        if (this.failWith !== undefined) throw this.failWith
    }
}

let didCounter = 0
const freshDID = () => `did:plc:removed-test-${(didCounter += 1)}`

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

async function register(did: string, secretKey: Uint8Array, directory: KVDirectory) {
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

describe("KVDirectory.onRemoved", () => {
    it("fires once on deregister, with the removed registration's locator", async () => {
        const directory = new RecordingDirectory(testEnv)
        const did = freshDID()
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        const locator = (await directory.resolve(did))!
        await directory.deregister(did, thumb(key))
        expect(directory.removed).toEqual([{ did, locator }])
        expect(directory.resolvedDuring).toEqual([null])
        expect(await directory.resolve(did)).toBeNull()
    })

    it("fires once on a different-key replace", async () => {
        const directory = new RecordingDirectory(testEnv)
        const did = freshDID()
        await register(did, ed25519.utils.randomSecretKey(), directory)
        const first = (await directory.resolve(did))!
        await register(did, ed25519.utils.randomSecretKey(), directory)
        const second = (await directory.resolve(did))!
        expect(second).not.toBe(first)
        expect(directory.removed).toEqual([{ did, locator: first }])
    })

    it("fires once on retire by a verified-anchor observation", async () => {
        const directory = new RecordingDirectory(testEnv)
        const did = freshDID()
        await register(did, ed25519.utils.randomSecretKey(), directory)
        const locator = (await directory.resolve(did))!
        expect(await directory.retire(did, locator)).toBe(locator)
        expect(directory.removed).toEqual([{ did, locator }])
    })

    it("does not fire on a same-key re-register or for an unknown DID", async () => {
        const directory = new RecordingDirectory(testEnv)
        const did = freshDID()
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        await register(did, key, directory)
        await directory.delete(freshDID())
        await directory.deregister(freshDID(), thumb(key))
        expect(await directory.retire(did, "stale-locator")).toBeNull()
        expect(directory.removed).toEqual([])
    })

    it("a throwing onRemoved does not fail the removal", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const directory = new RecordingDirectory(testEnv)
        directory.failWith = new Error("index down")
        const did = freshDID()
        const key = ed25519.utils.randomSecretKey()
        await register(did, key, directory)
        await expect(directory.deregister(did, thumb(key))).resolves.toBeUndefined()
        expect(await directory.resolve(did)).toBeNull()
        expect(directory.removed).toHaveLength(1)
        expect(warn.mock.calls.some((c) => String(c[0]).includes("onRemoved"))).toBe(true)
        warn.mockRestore()
    })
})
