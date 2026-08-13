/**
 * Declaration resolution (DID -> DID document -> PDS -> declaration),
 * against an injected `fetchImpl` fixture — never a real network call.
 *
 * The field facts pinned here — the collection NSID, the `currentKey`
 * field name, the algorithm byte, and the PDS-service resolution shape —
 * were each verified against a shipping implementation rather than assumed.
 * If one of these fails, the record format changed; that is a wire break,
 * never a test to update.
 */
import { describe, expect, it } from "vitest"
import { resolveDeclaration } from "../src/declaration"

const DID_PLC = "did:plc:abcdefghijklmnopqrstuvwx"
const DID_WEB = "did:web:example.com"
const PDS_URL = "https://pds.example.com"

/**
 * Builds the wire shape a real PDS would actually return: atproto's
 * `{"$bytes": "<unpadded standard base64>"}`, over the declaration's
 * algorithm-prefixed key bytes (`[algorithm] + keyBytes`). An earlier draft of
 * these fixtures encoded plain number arrays / a `Uint8Array` directly —
 * which `JSON.parse` can never actually produce, so those fixtures would
 * have passed while a real PDS response would have silently failed the
 * same code path. Caught before running by checking what `response.json()`
 * can actually return.
 */
function algorithmPrefixedKey(algByte: number, keyBytes: Uint8Array): unknown {
    const wireBytes = new Uint8Array([algByte, ...keyBytes])
    let binary = ""
    for (const byte of wireBytes) binary += String.fromCharCode(byte)
    const base64 = btoa(binary).replace(/=+$/, "")
    return { $bytes: base64 }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    })
}

/**
 * `id` is a parameter because a DID document must claim the DID it was
 * fetched for — reusing one document across two DIDs is exactly what the
 * id check refuses.
 */
function didDocument(pdsUrl: string, id: string = DID_PLC): unknown {
    return {
        id,
        service: [
            {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: pdsUrl,
            },
        ],
    }
}

function declarationRecord(currentKey: unknown): unknown {
    return {
        value: {
            version: "1.1.0",
            currentKey,
        },
    }
}

/** Routes by URL prefix, so a test only needs to describe what matters to it. */
function fixtureFetch(
    routes: Record<string, () => Response>
): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        for (const [prefix, respond] of Object.entries(routes)) {
            if (url.startsWith(prefix)) return respond()
        }
        throw new Error(`fixtureFetch: no route for ${url}`)
    }) as typeof fetch
}

/**
 * A fixture that records every request and the options it was given.
 *
 * Needed because several properties here are about what the resolver
 * *does not do* — a URL it must never request, an option it must always
 * pass — and asserting only on the returned value lets a test pass for
 * the wrong reason.
 */
function recordingFetch(routes: Record<string, () => Response>) {
    const calls: { url: string; init?: RequestInit }[] = []
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        calls.push({ url, init })
        for (const [prefix, respond] of Object.entries(routes)) {
            if (url.startsWith(prefix)) return respond()
        }
        throw new Error(`recordingFetch: no route for ${url}`)
    }) as typeof fetch
    return { impl, calls }
}

describe("happy path: did:plc -> PLC directory -> PDS -> declaration", () => {
    it("resolves a well-formed Ed25519 currentKey", async () => {
        const keyBytes = new Uint8Array(32).map((_, i) => i)
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(
                    // Algorithm 2 is Curve25519 signing (Ed25519). See
                    // the identifier table in src/declaration.ts.
                    declarationRecord(algorithmPrefixedKey(2, keyBytes))
                ),
        })

        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(true)
        if (!result.found) throw new Error("unreachable")
        expect([...result.anchorKey.x]).toEqual([...keyBytes])
    })
})

describe("happy path: did:web -> well-known document -> PDS -> declaration", () => {
    it("resolves via the did:web well-known path", async () => {
        const keyBytes = new Uint8Array(32).fill(0x42)
        const fetchImpl = fixtureFetch({
            "https://example.com/.well-known/did.json": () =>
                jsonResponse(didDocument(PDS_URL, DID_WEB)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
        })

        const result = await resolveDeclaration(DID_WEB, fetchImpl)
        expect(result.found).toBe(true)
    })
})

describe("the algorithm byte matters — Curve25519_Signing (2), never KeyAgreement (1)", () => {
    it("rejects a KeyAgreement (X25519) key presented where a signing key belongs", async () => {
        const keyBytes = new Uint8Array(32).fill(0x11)
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(
                    // byte 1 = Curve25519_KeyAgreement, a DIFFERENT key type
                    declarationRecord(algorithmPrefixedKey(1, keyBytes))
                ),
        })

        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
        if (result.found) throw new Error("unreachable")
        expect(result.reason).toMatch(/algorithm byte/)
    })

    it("rejects an unknown algorithm byte", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(
                    declarationRecord(algorithmPrefixedKey(99, new Uint8Array(32)))
                ),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
    })
})

describe("malformed input", () => {
    it("rejects a currentKey of the wrong length", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(
                    declarationRecord(algorithmPrefixedKey(2, new Uint8Array(3))) // way too short
                ),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
        if (result.found) throw new Error("unreachable")
        expect(result.reason).toMatch(/33 bytes/)
    })

    it("reports absence, not throws, when currentKey is missing entirely", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse({ value: { version: "1.1.0" } }),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
    })

    it("rejects a currentKey that is a bare array or string, not the real {$bytes:...} wire shape", async () => {
        // Pins the bug caught while writing these fixtures: a JSON response
        // can never deserialize to a Uint8Array, and atproto's actual bytes
        // representation is {"$bytes": "<base64>"}. An implementation that
        // checked `instanceof Uint8Array` would reject every real response.
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord([2, 1, 2, 3])),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
        if (result.found) throw new Error("unreachable")
        expect(result.reason).toMatch(/bytes object/)
    })
})

describe("resolution failures are reported, not thrown", () => {
    it("PLC directory 404", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse({}, 404),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
        if (result.found) throw new Error("unreachable")
        expect(result.reason).toMatch(/PDS resolution failed/)
    })

    it("DID document with no AtprotoPersonalDataServer service", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse({ id: DID_PLC, service: [] }),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
    })

    it("PDS answers non-200 for the declaration fetch", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse({}, 404),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
        if (result.found) throw new Error("unreachable")
        expect(result.reason).toMatch(/404/)
    })

    it("unsupported DID method", async () => {
        const result = await resolveDeclaration(
            "did:key:z6Mk...",
            fixtureFetch({})
        )
        expect(result.found).toBe(false)
    })
})

/**
 * These pin the five places our resolver had drifted from
 * `@atproto/identity`. Each one was a real bug, and one was a security
 * hole — so they are here to stop the drift returning, not to describe
 * behaviour that was always right.
 */
describe("PDS resolution matches @atproto/identity", () => {
    it("refuses a DID document that claims a different DID", async () => {
        // A directory handing back the wrong document would otherwise pick
        // the host that serves this DID's declaration — and so its anchor
        // key. The declaration route is wired here on purpose: without the
        // id check, resolution SUCCEEDS, so a bare found:false would pass
        // for the wrong reason.
        const keyBytes = new Uint8Array(32).fill(0x44)
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse(didDocument(PDS_URL, "did:plc:somebodyelse00000000000")),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(false)
    })

    it("refuses a path-form did:web WITHOUT fetching anything", async () => {
        // did:web puts that document at /user/alice/did.json, not under
        // /.well-known/ — and atproto does not support the form at all.
        // The property is that no request is made: an earlier version
        // fetched a confidently wrong URL, which a found:false assertion
        // alone would not have caught.
        const { impl, calls } = recordingFetch({
            "https://": () => jsonResponse(didDocument(PDS_URL)),
        })
        const result = await resolveDeclaration(
            "did:web:example.com:user:alice",
            impl
        )
        expect(result.found).toBe(false)
        expect(calls).toEqual([])
    })

    it("percent-decodes a did:web host, so a port survives", async () => {
        const keyBytes = new Uint8Array(32).fill(0x11)
        const did = "did:web:example.com%3A3000"
        const fetchImpl = fixtureFetch({
            "https://example.com:3000/.well-known/did.json": () =>
                jsonResponse(didDocument(PDS_URL, did)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
        })
        const result = await resolveDeclaration(did, fetchImpl)
        expect(result.found).toBe(true)
    })

    it("selects the service by #atproto_pds id, not by type alone", async () => {
        // A document whose id and type entries disagree must resolve the
        // same way here as everywhere else in the network.
        const keyBytes = new Uint8Array(32).fill(0x22)
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse({
                    id: DID_PLC,
                    service: [
                        {
                            id: "#something_else",
                            type: "AtprotoPersonalDataServer",
                            serviceEndpoint: "https://impostor.example",
                        },
                        {
                            id: "#atproto_pds",
                            type: "AtprotoPersonalDataServer",
                            serviceEndpoint: PDS_URL,
                        },
                    ],
                }),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
            "https://impostor.example": () => {
                throw new Error("resolved to the wrong service entry")
            },
        })
        const result = await resolveDeclaration(DID_PLC, fetchImpl)
        expect(result.found).toBe(true)
    })

    it("accepts the absolute service id form", async () => {
        const keyBytes = new Uint8Array(32).fill(0x33)
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse({
                    id: DID_PLC,
                    service: [
                        {
                            id: `${DID_PLC}#atproto_pds`,
                            type: "AtprotoPersonalDataServer",
                            serviceEndpoint: PDS_URL,
                        },
                    ],
                }),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
        })
        expect((await resolveDeclaration(DID_PLC, fetchImpl)).found).toBe(true)
    })

    it("refuses a #atproto_pds entry whose type is wrong", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse({
                    id: DID_PLC,
                    service: [
                        {
                            id: "#atproto_pds",
                            type: "SomethingElse",
                            serviceEndpoint: PDS_URL,
                        },
                    ],
                }),
        })
        expect((await resolveDeclaration(DID_PLC, fetchImpl)).found).toBe(false)
    })

    it("refuses a non-http(s) service endpoint", async () => {
        const fetchImpl = fixtureFetch({
            "https://plc.directory/": () =>
                jsonResponse(didDocument("file:///etc/passwd")),
        })
        expect((await resolveDeclaration(DID_PLC, fetchImpl)).found).toBe(false)
    })

    it("asks fetch to refuse redirects on every request", async () => {
        // Whether a redirect is followed is the real fetch's behaviour, not
        // something a fixture can exercise — so the property pinned here is
        // that the option is actually passed. Without it the https check is
        // decorative: it validates the URL we chose, and a 302 goes
        // somewhere it never runs again.
        const keyBytes = new Uint8Array(32).fill(0x55)
        const { impl, calls } = recordingFetch({
            "https://plc.directory/": () => jsonResponse(didDocument(PDS_URL)),
            [`${PDS_URL}/xrpc/com.atproto.repo.getRecord`]: () =>
                jsonResponse(declarationRecord(algorithmPrefixedKey(2, keyBytes))),
        })
        expect((await resolveDeclaration(DID_PLC, impl)).found).toBe(true)

        // Both hops: the directory and the PDS.
        expect(calls.length).toBe(2)
        for (const call of calls) {
            expect(call.init?.redirect).toBe("error")
        }
    })
})
