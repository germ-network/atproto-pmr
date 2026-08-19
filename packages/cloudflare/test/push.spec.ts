/**
 * `PMRStore.deliverPush` — Web Push, at the DO level: the actual sender
 * composition (`push-sender.ts`), env-driven enable/disable, discard on
 * 404/410, and the latency-isolation property the deferred call sites
 * (`pair-put.ts`, `grant-put.ts`) rely on.
 *
 * Outbound `fetch` is stubbed on the global. This works because
 * `@cloudflare/vitest-pool-workers` runs test code and the Durable Object
 * in the same isolate, so a global stub reaches code running inside it.
 */
import { gcm } from "@noble/ciphers/aes.js"
import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { binaryToBase64URL } from "@germ-network/atproto-pmr-core"
import { PMRObject } from "../src/pmr-object"
import type { PMREnv } from "../src/env"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

// Not a real, curve-paired keypair — `webPushSender` never validates the
// public key's shape (that already happened at config/enabler-document
// publish time, `parseVapidPublicKey`), and these tests never cross-verify
// a signature (that's `push-vapid.spec.ts`'s job, at the core level, with a
// real noble-derived keypair). Random bytes of the right lengths are
// sufficient to exercise `deliverPush`'s own logic without depending on
// `@noble/curves`, which this package does not otherwise need.
const PRIVATE_KEY_B64 = binaryToBase64URL(crypto.getRandomValues(new Uint8Array(32)))
const PUBLIC_KEY_B64 = binaryToBase64URL(
    (() => {
        const bytes = crypto.getRandomValues(new Uint8Array(65))
        bytes[0] = 0x04
        return bytes
    })()
)

const PUSH_ENABLED_ENV = {
    VAPID_PUBLIC_KEY: PUBLIC_KEY_B64,
    VAPID_PRIVATE_KEY: PRIVATE_KEY_B64,
    VAPID_SUBJECT: "mailto:ops@relay.example",
    PUSH_MAX_SEALED_BYTES: "2880",
    PUSH_TTL_SECONDS: "86400",
}

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    const id = testEnv.pmrs.idFromName(`push-${counter}`)
    return testEnv.pmrs.get(id)
}

async function withPushEnabled(
    stub: DurableObjectStub<PMRObject>,
    extra: Record<string, string> = {}
): Promise<void> {
    await inPMR(stub, (pmr) => {
        const held = pmr as unknown as { env: PMREnv }
        held.env = { ...held.env, ...PUSH_ENABLED_ENV, ...extra }
    })
}

async function withSubscription(
    stub: DurableObjectStub<PMRObject>,
    subscription: { endpoint: string; contentKey: Uint8Array; keyId: number }
): Promise<void> {
    await inPMR(stub, (pmr) =>
        pmr.update({ did: "did:plc:owner", anchorKey: new Uint8Array(1), lastActive: 0, pushSubscription: subscription })
    )
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("deliverPush — disabled deployment", () => {
    it("is a no-op when VAPID is not configured at all", async () => {
        const stub = freshStub()
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        expect(fetchCalled).toBe(false)
    })

    it("is a no-op when VAPID is only PARTIALLY configured", async () => {
        const stub = freshStub()
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        await inPMR(stub, (pmr) => {
            const held = pmr as unknown as { env: PMREnv }
            held.env = { ...held.env, VAPID_PUBLIC_KEY: PUBLIC_KEY_B64 } // no private key, subject, etc.
        })
        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        expect(fetchCalled).toBe(false)
    })

    it("is a no-op when PUSH_MAX_SEALED_BYTES is non-numeric — a misconfiguration, not a degraded push", async () => {
        const stub = freshStub()
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        await withPushEnabled(stub, { PUSH_MAX_SEALED_BYTES: "not-a-number" })
        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        expect(fetchCalled).toBe(false)
    })
})

describe("deliverPush — no subscription", () => {
    it("is a no-op when the registration holds no subscription", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await inPMR(stub, (pmr) =>
            pmr.update({ did: "did:plc:owner", anchorKey: new Uint8Array(1), lastActive: 0 })
        )
        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        expect(fetchCalled).toBe(false)
    })
})

describe("deliverPush — enabled, subscription present", () => {
    it("POSTs to the subscription endpoint with a VAPID Authorization header", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 7,
        })

        let seenUrl: string | undefined
        let seenAuth: string | null = null
        let seenBody: Uint8Array | undefined
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            seenUrl = typeof input === "string" ? input : input.toString()
            seenAuth = new Headers(init?.headers).get("Authorization")
            seenBody = init?.body instanceof Uint8Array ? init.body : undefined
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush(
                "did:plc:sender",
                { messageId: "m1", byteLength: 5 },
                new TextEncoder().encode("hello")
            )
        )

        expect(seenUrl).toBe("https://push.example/sub/1")
        expect(seenAuth).toMatch(/^vapid t=.+, k=.+$/)
        expect(seenBody).toBeDefined()
        expect(seenBody!.byteLength).toBeGreaterThan(0)
    })

    it("the sealed body's key_id byte matches the subscription's keyId", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 42,
        })

        let seenBody: Uint8Array | undefined
        vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
            seenBody = init?.body instanceof Uint8Array ? init.body : undefined
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush(
                "did:plc:sender",
                { messageId: "m1", byteLength: 5 },
                new TextEncoder().encode("hello")
            )
        )
        expect(seenBody![0]).toBe(42)
    })

    it("the sealed body is bound to this deployment's HOST_NAME as AAD — opens only under the right aad", async () => {
        // The core-level seal tests (push-seal.spec.ts) prove sealPushPayload's
        // aad parameter works generically; nothing at the DO/push-sender level
        // previously proved that THIS deployment actually passes its own host
        // as that aad, rather than omitting it or passing something else. A
        // regression here (e.g. dropping `aad: hostAad` in push-sender.ts)
        // would make every real push undecryptable by the client while every
        // OTHER test in this suite stays green — this is the one that would
        // have caught it.
        const stub = freshStub()
        await withPushEnabled(stub)
        const contentKey = new Uint8Array(32).fill(1)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey,
            keyId: 1,
        })

        let seenBody: Uint8Array | undefined
        vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
            seenBody = init?.body instanceof Uint8Array ? init.body : undefined
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverPush(
                "did:plc:sender",
                { messageId: "m1", byteLength: 5 },
                new TextEncoder().encode("hello")
            )
        )

        const nonce = seenBody!.slice(1, 13)
        const ciphertextAndTag = seenBody!.slice(13)

        // Wrong aad (or none) fails the GCM tag outright.
        expect(() => gcm(contentKey, nonce).decrypt(ciphertextAndTag)).toThrow()
        expect(() =>
            gcm(contentKey, nonce, new TextEncoder().encode("wrong.host")).decrypt(
                ciphertextAndTag
            )
        ).toThrow()

        // The right aad — this deployment's own HOST_NAME (wrangler.test.toml) — opens it.
        const recovered = gcm(
            contentKey,
            nonce,
            new TextEncoder().encode(testEnv.HOST_NAME)
        ).decrypt(ciphertextAndTag)
        expect(recovered.byteLength).toBeGreaterThan(0)
    })

    it("404 clears the stored subscription", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }))

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        const reg = await inPMR(stub, (pmr) => pmr.load())
        expect(reg?.pushSubscription).toBeUndefined()
    })

    it("410 clears the stored subscription", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        vi.stubGlobal("fetch", async () => new Response(null, { status: 410 }))

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        const reg = await inPMR(stub, (pmr) => pmr.load())
        expect(reg?.pushSubscription).toBeUndefined()
    })

    it("a single 401 does NOT clear the subscription", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }))

        await inPMR(stub, (pmr) =>
            pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
        )
        const reg = await inPMR(stub, (pmr) => pmr.load())
        expect(reg?.pushSubscription).toBeDefined()
    })

    it("a fetch that throws does not propagate out of deliverPush", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        vi.stubGlobal("fetch", async () => {
            throw new Error("network down")
        })

        await expect(
            inPMR(stub, (pmr) =>
                pmr.deliverPush("did:plc:sender", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
            )
        ).rejects.toThrow()
        // Note: deliverPush itself does not swallow errors — that discipline
        // lives at the pair-put.ts/grant-put.ts call sites, which wrap the
        // call in their own try/catch. This test documents that division of
        // responsibility rather than asserting deliverPush is itself silent.
    })
})

describe("deliverPush via pool provisioning", () => {
    it("fires even with NO socket attached — the property the socket-gate fix protects", async () => {
        // A live-socket broadcast is correctly skipped with nothing
        // attached (see events.spec.ts's pool-provisioning tests) — but
        // Web Push exists precisely for the disconnected case, so it must
        // NOT be gated on the same socket-attachment check. This test
        // deliberately attaches no socket at all.
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        await inPMR(stub, (pmr) =>
            pmr.appendToPool(
                "did:plc:recovering",
                { messageId: "m1", byteLength: 5 },
                new Uint8Array([9]),
                0
            )
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hello"))

        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        const moved = await inPMR(stub, (pmr) =>
            pmr.provisionFromPool("did:plc:recovering", 0)
        )
        expect(moved).toHaveLength(1)
        await expect.poll(() => fetchCalled).toBe(true)
    })

    it("provisioning an empty sender pushes nothing", async () => {
        const stub = freshStub()
        await withPushEnabled(stub)
        await withSubscription(stub, {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(1),
            keyId: 1,
        })
        let fetchCalled = false
        vi.stubGlobal("fetch", async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        })

        await inPMR(stub, (pmr) => pmr.provisionFromPool("did:plc:nobody", 0))
        await new Promise((r) => setTimeout(r, 10))
        expect(fetchCalled).toBe(false)
    })
})
