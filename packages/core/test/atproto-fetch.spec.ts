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
import { describe, expect, it, vi } from "vitest"
import { BodyTooLargeError } from "../src/util"
import {
    fetchPlcAuditLog,
    FetchTimeoutError,
    guardedFetchBytes,
    guardedFetchStream,
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

describe("fetchPlcAuditLog", () => {
    it("asks the directory for the DID's audit log, with a cap above a DID document's", async () => {
        const urls: string[] = []
        const big = JSON.stringify(
            Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(900) }))
        )
        expect(big.length).toBeGreaterThan(64 * 1024)
        const fetchImpl = (async (url: string) => {
            urls.push(url)
            return new Response(big, { status: 200 })
        }) as unknown as typeof fetch
        const body = (await fetchPlcAuditLog("did:plc:abcdefghijklmnopqrstuvwx", fetchImpl)) as unknown[]
        expect(urls).toEqual(["https://plc.directory/did%3Aplc%3Aabcdefghijklmnopqrstuvwx/log/audit"])
        expect(body).toHaveLength(200)
    })

    it("refuses a DID that is not did:plc", () => {
        expect(() => fetchPlcAuditLog("did:web:example.com", fetch)).toThrow(/did:plc/)
    })
})

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

    it("throws RecordNotFoundError when the body names a caller-supplied terminal XRPC error", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RecordNotFound", message: "nope" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalErrorNames: ["RecordNotFound"],
        })
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
        // Default when a name is terminal but not listed as permanent.
        await expect(rejection).rejects.toMatchObject({ permanent: true })
    })

    it("permanentErrorNames narrows a terminal XRPC error to reversible", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RepoSuspended" }), { status: 400 })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalErrorNames: ["RepoSuspended", "RepoNotFound"],
            permanentErrorNames: ["RepoNotFound"],
        })
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
        await expect(rejection).rejects.toMatchObject({ permanent: false })
    })

    it("an error name NOT in terminalErrorNames stays the generic error", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalErrorNames: ["RecordNotFound"],
        })
        await expect(rejection).rejects.toThrow(/400/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("a non-terminal XRPC error names itself in the thrown message", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 })) as typeof fetch
        const options = { terminalErrorNames: ["RecordNotFound"] }
        await expect(guardedFetchJSON(URL_, fetchImpl, options)).rejects.toThrow(
            "endpoint answered 400 InvalidRequest"
        )
        await expect(guardedFetchBytes(URL_, fetchImpl, options)).rejects.toThrow(
            "endpoint answered 400 InvalidRequest"
        )
        await expect(
            guardedFetchStream(URL_, fetchImpl, { ...options, timeoutMs: 1000, maxBytes: 1000 })
        ).rejects.toThrow("endpoint answered 400 InvalidRequest")
    })

    it("a terminal XRPC error stays generic when terminalErrorNames is omitted -- opt-in only", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RecordNotFound" }), { status: 404 })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl)
        await expect(rejection).rejects.toThrow(/404/)
        await expect(rejection).rejects.not.toBeInstanceOf(RecordNotFoundError)
    })

    it("reads the failing body once and still matches a message prefix when both options are set", async () => {
        // A PLC-style body carrying only `message` (no `error`) must still be
        // caught by terminalMessagePrefixes even when terminalErrorNames is
        // also configured — the single combined read must not drop it.
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: "DID not available: did:plc:xyz" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, fetchImpl, {
            terminalErrorNames: ["RecordNotFound"],
            terminalMessagePrefixes: ["DID not available: "],
        })
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
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

    it("refuses a document that claims a different DID", async () => {
        const fetchImpl = (async () =>
            new Response(
                JSON.stringify({
                    id: "did:plc:someoneelse",
                    service: [
                        {
                            id: "#atproto_pds",
                            type: "AtprotoPersonalDataServer",
                            serviceEndpoint: "https://evil.example",
                        },
                    ],
                }),
                { status: 200 }
            )) as typeof fetch
        await expect(resolvePDSEndpoint(PLC_DID, fetchImpl)).rejects.toThrow(
            /does not match the requested DID/
        )
    })

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

describe("RecordNotFoundError.reason", () => {
    // A caller tells a missing record from a gone repo by the XRPC error name.
    it("guardedFetchBytes: a terminal XRPC error carries its error name as reason", async () => {
        for (const name of ["RecordNotFound", "RepoTakendown"]) {
            const fetchImpl = (async () =>
                new Response(JSON.stringify({ error: name }), { status: 400 })) as typeof fetch
            await expect(
                guardedFetchBytes(URL_, fetchImpl, { terminalErrorNames: [name] })
            ).rejects.toMatchObject({ reason: name })
        }
    })

    it("guardedFetchJSON: a terminal XRPC error name carries through as reason; a message-prefix match has a null reason", async () => {
        const named = (async () =>
            new Response(JSON.stringify({ error: "RepoNotFound" }), { status: 400 })) as typeof fetch
        await expect(
            guardedFetchJSON(URL_, named, { terminalErrorNames: ["RepoNotFound"] })
        ).rejects.toMatchObject({ reason: "RepoNotFound" })

        const tombstone = (async () =>
            new Response(JSON.stringify({ message: "DID not available: did:plc:xyz" }), {
                status: 404,
            })) as typeof fetch
        const rejection = guardedFetchJSON(URL_, tombstone, {
            terminalMessagePrefixes: ["DID not available: "],
        })
        await expect(rejection).rejects.toBeInstanceOf(RecordNotFoundError)
        await expect(rejection).rejects.toMatchObject({ reason: null })
    })
})

describe("guardedFetchStream", () => {
    const options = { timeoutMs: 1_000, maxBytes: 1_000 }

    /** A body that yields `chunks`, then waits until `signal` aborts it. */
    function hangingBody(chunks: Uint8Array[], signal: AbortSignal | null | undefined) {
        let sent = 0
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent < chunks.length) {
                    controller.enqueue(chunks[sent++]!)
                    return
                }
                return new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError"))
                    )
                })
            },
        })
    }

    async function collect(stream: AsyncIterable<Uint8Array>): Promise<number[]> {
        const sizes: number[] = []
        for await (const chunk of stream) sizes.push(chunk.length)
        return sizes
    }

    it("refuses a non-https endpoint and a redirect", async () => {
        const never = (async () => {
            throw new Error("fetched")
        }) as typeof fetch
        await expect(
            guardedFetchStream("http://pds.example.com/x", never, options)
        ).rejects.toThrow(/non-https/)
        const redirect = (async () =>
            cloudflareStyleRedirect("https://evil.example/steal")) as typeof fetch
        await expect(guardedFetchStream(URL_, redirect, options)).rejects.toThrow(
            /redirect/
        )
        let seen: string | undefined
        const spy = (async (_input, init) => {
            seen = init?.redirect
            return new Response(new Uint8Array(1))
        }) as typeof fetch
        await guardedFetchStream(URL_, spy, options)
        expect(seen).toBe("manual")
    })

    it("yields the body in chunks without buffering it whole", async () => {
        const chunks = [new Uint8Array(100), new Uint8Array(200), new Uint8Array(50)]
        let pulled = 0
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        const next = chunks[pulled++]
                        if (next === undefined) controller.close()
                        else controller.enqueue(next)
                    },
                })
            )) as typeof fetch
        const stream = await guardedFetchStream(URL_, fetchImpl, options)
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        expect(first.value?.length).toBe(100)
        expect(pulled).toBeLessThan(chunks.length)
        const rest = [first.value!.length]
        for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
            rest.push(r.value.length)
        }
        expect(rest).toEqual([100, 200, 50])
    })

    it("a body past maxBytes ends the stream with BodyTooLargeError", async () => {
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(600))
                        controller.enqueue(new Uint8Array(600))
                        controller.close()
                    },
                })
            )) as typeof fetch
        const stream = await guardedFetchStream(URL_, fetchImpl, options)
        await expect(collect(stream)).rejects.toBeInstanceOf(BodyTooLargeError)
    })

    it("a body still arriving after timeoutMs is aborted with FetchTimeoutError", async () => {
        const midBody = (async (_input, init) =>
            new Response(
                hangingBody([new Uint8Array(10)], init?.signal)
            )) as typeof fetch
        const stream = await guardedFetchStream(URL_, midBody, {
            ...options,
            timeoutMs: 20,
        })
        await expect(collect(stream)).rejects.toBeInstanceOf(FetchTimeoutError)

        const noHeaders = (async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError"))
                )
            })) as typeof fetch
        await expect(
            guardedFetchStream(URL_, noHeaders, { ...options, timeoutMs: 20 })
        ).rejects.toBeInstanceOf(FetchTimeoutError)
    })

    it("a consumer that stops early cancels the body and clears the timer", async () => {
        const cancelled = vi.fn()
        const fetchImpl = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        controller.enqueue(new Uint8Array(10))
                    },
                    cancel: cancelled,
                })
            )) as typeof fetch
        const clear = vi.spyOn(globalThis, "clearTimeout")
        const stream = await guardedFetchStream(URL_, fetchImpl, options)
        for await (const _chunk of stream) break
        expect(cancelled).toHaveBeenCalledTimes(1)
        expect(clear).toHaveBeenCalled()
        clear.mockRestore()
    })

    it("a terminal XRPC error carries its error name as reason", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: "RepoTakendown" }), {
                status: 400,
            })) as typeof fetch
        await expect(
            guardedFetchStream(URL_, fetchImpl, {
                ...options,
                terminalErrorNames: ["RepoTakendown"],
                permanentErrorNames: [],
            })
        ).rejects.toMatchObject({ reason: "RepoTakendown", permanent: false })
        await expect(
            guardedFetchStream(URL_, fetchImpl, options)
        ).rejects.toThrow(/answered 400/)
    })
})
