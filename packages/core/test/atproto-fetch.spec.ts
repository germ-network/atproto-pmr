/**
 * The bounded fetch guards `guardedFetchJSON`/`guardedFetchBytes` share.
 *
 * The redirect refusal is the property worth pinning hardest: production
 * ran with `redirect: "error"`, which the Fetch spec allows but Cloudflare
 * Workers' `fetch()` does not implement, throwing a TypeError on every
 * single call — invisible in this suite until now because every fixture
 * here is a hand-rolled `fetchImpl` that never validates its `init`
 * argument the way a real runtime does. `redirect: "manual"` fixes the
 * platform incompatibility; these tests pin the refusal that "error" used
 * to provide automatically.
 */
import { describe, expect, it } from "vitest"
import { guardedFetchBytes, guardedFetchJSON } from "../src/atproto-fetch"

const URL_ = "https://pds.example.com/xrpc/thing"

/** Cloudflare Workers' actual shape under `redirect: "manual"`: the PDS's
 * real 3xx status and Location header, not an opaque status-0 response. */
function cloudflareStyleRedirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } })
}

/**
 * The WHATWG spec's shape under `redirect: "manual"` (browsers, undici) --
 * a status-0 response with `type: "opaqueredirect"`, which no runtime's
 * `Response` constructor can actually produce (it is fetch()'s own
 * internal construct), so this fakes the two fields `isRedirect` reads.
 */
function opaqueRedirect(): Response {
    return { status: 0, type: "opaqueredirect", ok: false } as unknown as Response
}

describe("guardedFetchJSON", () => {
    it("refuses a Cloudflare-style redirect (real 3xx status, Location header)", async () => {
        const fetchImpl = (async () =>
            cloudflareStyleRedirect("https://evil.example/steal")) as typeof fetch
        await expect(guardedFetchJSON(URL_, fetchImpl)).rejects.toThrow(/redirect/)
    })

    it("refuses a spec-style opaque redirect (status 0, type opaqueredirect)", async () => {
        const fetchImpl = (async () => opaqueRedirect()) as typeof fetch
        await expect(guardedFetchJSON(URL_, fetchImpl)).rejects.toThrow(/redirect/)
    })

    it("passes redirect: manual, never error — Cloudflare Workers throws on error", async () => {
        let seenRedirect: string | undefined
        const fetchImpl = (async (_input, init) => {
            seenRedirect = init?.redirect
            return new Response(JSON.stringify({ ok: true }), {
                headers: { "content-type": "application/json" },
            })
        }) as typeof fetch
        await guardedFetchJSON(URL_, fetchImpl)
        expect(seenRedirect).toBe("manual")
    })

    it("still returns a genuine 200's body", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ hello: "world" }), {
                headers: { "content-type": "application/json" },
            })) as typeof fetch
        await expect(guardedFetchJSON(URL_, fetchImpl)).resolves.toEqual({ hello: "world" })
    })

    it("still rejects a non-ok, non-redirect status", async () => {
        const fetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch
        await expect(guardedFetchJSON(URL_, fetchImpl)).rejects.toThrow(/500/)
    })
})

describe("guardedFetchBytes", () => {
    it("refuses a Cloudflare-style redirect", async () => {
        const fetchImpl = (async () =>
            cloudflareStyleRedirect("https://evil.example/steal")) as typeof fetch
        await expect(guardedFetchBytes(URL_, fetchImpl)).rejects.toThrow(/redirect/)
    })

    it("passes redirect: manual, never error", async () => {
        let seenRedirect: string | undefined
        const fetchImpl = (async (_input, init) => {
            seenRedirect = init?.redirect
            return new Response(new Uint8Array([1, 2, 3]))
        }) as typeof fetch
        await guardedFetchBytes(URL_, fetchImpl)
        expect(seenRedirect).toBe("manual")
    })

    it("still returns genuine bytes", async () => {
        const bytes = new Uint8Array([0x0a, 0x0b, 0x0c])
        const fetchImpl = (async () => new Response(bytes)) as typeof fetch
        const result = await guardedFetchBytes(URL_, fetchImpl)
        expect([...result]).toEqual([...bytes])
    })
})
