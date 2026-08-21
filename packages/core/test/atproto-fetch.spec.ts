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
import {
    guardedFetchBytes,
    guardedFetchJSON,
    RecordNotFoundError,
    resolvePDSEndpoint,
} from "../src/atproto-fetch"

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

    it("throws a permanent RecordNotFoundError when the message matches a terminalMessagePrefix", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: "DID not available: did:plc:xyz" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalMessagePrefixes: ["DID not available: "],
        })
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
        await expect(rejection).rejects.toMatchObject({ permanent: true })
    })

    it("a message with a DIFFERENT prefix (never registered) stays the generic error", async () => {
        // The safer default: a DID this caller previously resolved
        // successfully answering "not registered" is anomalous, not a
        // confirmed state -- deliberately excluded from the prefix list
        // callers pass, so this must never be mistaken for confirmation.
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: "DID not registered: did:plc:xyz" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalMessagePrefixes: ["DID not available: "],
        })
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("a 404 with no message field at all stays the generic error, even with prefixes configured", async () => {
        const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalMessagePrefixes: ["DID not available: "],
        })
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("a matching message stays generic when terminalMessagePrefixes is omitted -- opt-in only", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: "DID not available: did:plc:xyz" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl)
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
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

    it("throws RecordNotFoundError when the body names a caller-supplied terminal error", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RepoNotFound", message: "gone" }), {
                status: 400,
            })) as typeof fetch
        await expect(
            guardedFetchBytes(URL_, fetchImpl, { terminalErrorNames: ["RepoNotFound"] })
        ).rejects.toBeInstanceOf(RecordNotFoundError)
    })

    it("a bare 404 with no matching error body is the generic error, NOT RecordNotFoundError", async () => {
        const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch
        const rejection = guardedFetchBytes(URL_, fetchImpl, {
            terminalErrorNames: ["RepoNotFound"],
        })
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("an error body naming something NOT in terminalErrorNames stays generic", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "InternalServerError" }), {
                status: 500,
            })) as typeof fetch
        const rejection = guardedFetchBytes(URL_, fetchImpl, {
            terminalErrorNames: ["RepoNotFound"],
        })
        await expect(rejection).rejects.toThrow(/500/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("a 500 is the generic error when no terminalErrorNames option is passed at all", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RepoNotFound" }), {
                status: 500,
            })) as typeof fetch
        const rejection = guardedFetchBytes(URL_, fetchImpl)
        await expect(rejection).rejects.toThrow(/500/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("an unparseable error body falls back to the generic error", async () => {
        const fetchImpl = (async () =>
            new Response("not json", { status: 400 })) as typeof fetch
        const rejection = guardedFetchBytes(URL_, fetchImpl, {
            terminalErrorNames: ["RepoNotFound"],
        })
        await expect(rejection).rejects.toThrow(/400/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("permanentErrorNames narrows which terminal names are permanent; the rest default true", async () => {
        const permanentBody = JSON.stringify({ error: "RepoNotFound" })
        const reversibleBody = JSON.stringify({ error: "RepoDeactivated" })
        const opts = {
            terminalErrorNames: ["RepoNotFound", "RepoDeactivated"],
            permanentErrorNames: ["RepoNotFound"],
        }

        const permanent = guardedFetchBytes(
            URL_,
            (async () => new Response(permanentBody, { status: 400 })) as typeof fetch,
            opts
        )
        await expect(permanent).rejects.toMatchObject({ permanent: true })

        const reversible = guardedFetchBytes(
            URL_,
            (async () => new Response(reversibleBody, { status: 400 })) as typeof fetch,
            opts
        )
        await expect(reversible).rejects.toMatchObject({ permanent: false })
    })

    it("omitting permanentErrorNames defaults every terminal match to permanent -- the pre-tiering behavior", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RepoDeactivated" }), {
                status: 400,
            })) as typeof fetch
        const rejection = guardedFetchBytes(URL_, fetchImpl, {
            terminalErrorNames: ["RepoDeactivated"],
        })
        await expect(rejection).rejects.toMatchObject({ permanent: true })
    })
})

describe("resolvePDSEndpoint", () => {
    const PLC_DID = "did:plc:alice1234567890123456789012"
    const plcUrl = `https://plc.directory/${encodeURIComponent(PLC_DID)}`

    it("a PLC tombstone (message prefix 'DID not available: ') is a permanent RecordNotFoundError", async () => {
        const fetchImpl = (async (input) => {
            if (input.toString() === plcUrl) {
                return new Response(
                    JSON.stringify({ message: `DID not available: ${PLC_DID}` }),
                    { status: 404 }
                )
            }
            throw new Error(`unexpected fetch: ${input}`)
        }) as typeof fetch

        const rejection = resolvePDSEndpoint(PLC_DID, fetchImpl)
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
        await expect(rejection).rejects.toMatchObject({ permanent: true })
    })

    it("a never-registered PLC DID ('DID not registered: ') stays the generic, retryable error", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: `DID not registered: ${PLC_DID}` }), {
                status: 404,
            })) as typeof fetch

        const rejection = resolvePDSEndpoint(PLC_DID, fetchImpl)
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("a did:web 404 is NEVER treated as confirmed deletion -- no directory to confirm against", async () => {
        const did = "did:web:example.com"
        const fetchImpl = (async () =>
            // Even a body that WOULD match the PLC prefix must not matter
            // here -- did:web gets no terminalMessagePrefixes at all.
            new Response(JSON.stringify({ message: "DID not available: did:web:example.com" }), {
                status: 404,
            })) as typeof fetch

        const rejection = resolvePDSEndpoint(did, fetchImpl)
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })
})
