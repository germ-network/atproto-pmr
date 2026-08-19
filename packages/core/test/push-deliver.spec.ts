import { describe, expect, it } from "vitest"
import { deliverPush } from "../src/push/deliver"

const ENDPOINT = "https://push.example/sub/abc"

function cloudflareStyleRedirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } })
}

function opaqueRedirect(): Response {
    return { status: 0, type: "opaqueredirect", ok: false } as unknown as Response
}

describe("deliverPush — outcome mapping", () => {
    it("2xx maps to delivered", async () => {
        const fetchImpl = (async () => new Response(null, { status: 201 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "delivered" })
    })

    it("404 maps to discard", async () => {
        const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "discard" })
    })

    it("410 maps to discard", async () => {
        const fetchImpl = (async () => new Response(null, { status: 410 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "discard" })
    })

    it("429 maps to retry, carrying Retry-After", async () => {
        const fetchImpl = (async () =>
            new Response(null, {
                status: 429,
                headers: { "Retry-After": "60" },
            })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "retry", retryAfterSeconds: 60 })
    })

    it("429 with no Retry-After header still maps to retry, with null", async () => {
        const fetchImpl = (async () => new Response(null, { status: 429 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "retry", retryAfterSeconds: null })
    })

    it("502 maps to failed, carrying the status", async () => {
        const fetchImpl = (async () => new Response(null, { status: 502 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "failed", status: 502 })
    })

    it("401 maps to failed, NOT discard — pins that a single 401 is not treated as dead", async () => {
        const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 86400,
        })
        expect(result).toEqual({ outcome: "failed", status: 401 })
    })
})

describe("deliverPush — request shape", () => {
    it("sends TTL, Content-Type, and the given Authorization header", async () => {
        let seenHeaders: Headers | undefined
        const fetchImpl = (async (_input, init) => {
            seenHeaders = new Headers(init?.headers)
            return new Response(null, { status: 201 })
        }) as typeof fetch
        await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
        })
        expect(seenHeaders?.get("TTL")).toBe("3600")
        expect(seenHeaders?.get("Content-Type")).toBe("application/webpush-message")
        expect(seenHeaders?.get("Authorization")).toBe("vapid t=x, k=y")
        expect(seenHeaders?.get("Content-Encoding")).toBeNull()
    })

    it("sends Topic and Urgency when given", async () => {
        let seenHeaders: Headers | undefined
        const fetchImpl = (async (_input, init) => {
            seenHeaders = new Headers(init?.headers)
            return new Response(null, { status: 201 })
        }) as typeof fetch
        await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
            topic: "mailbox-abc",
            urgency: "high",
        })
        expect(seenHeaders?.get("Topic")).toBe("mailbox-abc")
        expect(seenHeaders?.get("Urgency")).toBe("high")
    })

    it("omits Topic and Urgency when not given", async () => {
        let seenHeaders: Headers | undefined
        const fetchImpl = (async (_input, init) => {
            seenHeaders = new Headers(init?.headers)
            return new Response(null, { status: 201 })
        }) as typeof fetch
        await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
        })
        expect(seenHeaders?.has("Topic")).toBe(false)
        expect(seenHeaders?.has("Urgency")).toBe(false)
    })

    it("passes redirect: manual, never error", async () => {
        let seenRedirect: string | undefined
        const fetchImpl = (async (_input, init) => {
            seenRedirect = init?.redirect
            return new Response(null, { status: 201 })
        }) as typeof fetch
        await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
        })
        expect(seenRedirect).toBe("manual")
    })

    it("refuses a Cloudflare-style redirect rather than following it", async () => {
        const fetchImpl = (async () =>
            cloudflareStyleRedirect("https://evil.example/steal")) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
        })
        expect(result.outcome).toBe("failed")
    })

    it("refuses a spec-style opaque redirect rather than following it", async () => {
        const fetchImpl = (async () => opaqueRedirect()) as typeof fetch
        const result = await deliverPush(ENDPOINT, new Uint8Array([1]), {
            fetchImpl,
            authorizationHeader: "vapid t=x, k=y",
            ttlSeconds: 3600,
        })
        expect(result.outcome).toBe("failed")
    })

    it("refuses a non-https endpoint", async () => {
        const fetchImpl = (async () => new Response(null, { status: 201 })) as typeof fetch
        await expect(
            deliverPush("http://push.example/sub/abc", new Uint8Array([1]), {
                fetchImpl,
                authorizationHeader: "vapid t=x, k=y",
                ttlSeconds: 3600,
            })
        ).rejects.toThrow(/https/)
    })

    it("rejects a Topic over 32 chars locally, before any fetch", async () => {
        let fetchCalled = false
        const fetchImpl = (async () => {
            fetchCalled = true
            return new Response(null, { status: 201 })
        }) as typeof fetch
        await expect(
            deliverPush(ENDPOINT, new Uint8Array([1]), {
                fetchImpl,
                authorizationHeader: "vapid t=x, k=y",
                ttlSeconds: 3600,
                topic: "a".repeat(33),
            })
        ).rejects.toThrow(/Topic/)
        expect(fetchCalled).toBe(false)
    })

    it("rejects a Topic outside [A-Za-z0-9_-] locally", async () => {
        const fetchImpl = (async () => new Response(null, { status: 201 })) as typeof fetch
        await expect(
            deliverPush(ENDPOINT, new Uint8Array([1]), {
                fetchImpl,
                authorizationHeader: "vapid t=x, k=y",
                ttlSeconds: 3600,
                topic: "not valid!",
            })
        ).rejects.toThrow(/Topic/)
    })
})
