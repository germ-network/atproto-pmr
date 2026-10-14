/**
 * The authoritative read.
 *
 * Every fetch here is against a fixture — the point of injecting `fetch`
 * is that this suite never touches the network. What is pinned is which
 * endpoints are called and what is trusted: CAR from `sync.getRecord`, and
 * the `rev` from the PDS rather than from whatever prompted the read.
 */
import { describe, expect, it } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import { fetchHeadRev, fetchRecordCar } from "../src/fetch-record"

const DID = "did:plc:alice"
const PDS = "https://pds.example"
const COLLECTION = "com.germnetwork.declaration"
const CAR = new Uint8Array([0x0a, 0xa1, 0x63, 0x63, 0x61, 0x72])

const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

/** A PDS that answers the three calls a fetch makes, recording each URL. */
function fixture(
    overrides: Record<string, () => Response> = {},
    documentOverrides: Record<string, unknown> = {}
) {
    const seen: string[] = []
    const impl = (async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        for (const [match, make] of Object.entries(overrides)) {
            if (url.includes(match)) return make()
        }
        if (url.startsWith("https://plc.directory/")) {
            return Response.json({
                id: DID,
                service: [
                    {
                        id: "#atproto_pds",
                        type: "AtprotoPersonalDataServer",
                        serviceEndpoint: PDS,
                    },
                ],
                // Absolute id, matching what plc.directory actually serves
                // (verified against a live document — `did:plc:...#atproto`,
                // not bare `#atproto`).
                verificationMethod: [
                    {
                        id: `${DID}#atproto`,
                        type: "Multikey",
                        controller: DID,
                        publicKeyMultibase: SIGNING_KEY,
                    },
                ],
                ...documentOverrides,
            })
        }
        if (url.includes("sync.getRecord")) {
            return new Response(CAR, {
                headers: { "content-type": "application/vnd.ipld.car" },
            })
        }
        if (url.includes("sync.getLatestCommit")) {
            return Response.json({ cid: "bafy...", rev: "3mszqbq6s3y2k" })
        }
        return new Response(null, { status: 404 })
    }) as typeof fetch
    return { impl, seen }
}

describe("fetchRecordCar", () => {
    it("reads the record as CAR, and the rev from the PDS", async () => {
        const f = fixture()
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
        })
        expect(got.rev).toBe("3mszqbq6s3y2k")
        expect([...got.car]).toEqual([...CAR])
    })

    it("carries out the PDS it read from, and the signing key resolved with it", async () => {
        // Both computed already, by `resolvePDSEndpoint`, to find the PDS —
        // and previously thrown away. This is the provenance a client needs
        // to compare two monitors' observations under a common authority.
        const f = fixture()
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
        })
        expect(got.source).toBe(PDS)
        expect(got.signingKey).toBe(SIGNING_KEY)
    })

    it("carries a null signingKey rather than failing, when the document has none", async () => {
        // Absence does not block the fetch this module exists to make — a
        // monitor still serves what it read; an atproto client is what
        // fails a record against no key, not this resolver.
        const f = fixture({}, { verificationMethod: undefined })
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
        })
        expect(got.signingKey).toBeNull()
    })

    it("resolves the BARE #atproto id form too, not just absolute", async () => {
        const f = fixture(
            {},
            {
                verificationMethod: [
                    {
                        id: "#atproto",
                        type: "Multikey",
                        controller: DID,
                        publicKeyMultibase: SIGNING_KEY,
                    },
                ],
            }
        )
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
        })
        expect(got.signingKey).toBe(SIGNING_KEY)
    })

    it("carries the key through regardless of `type` — matches @atproto/identity, which never filters by it", async () => {
        // `getVerificationMaterial` returns `{type, publicKeyMultibase}`
        // unfiltered; only its OWN caller branches on `type` to know how to
        // parse the bytes cryptographically. A document still carrying a
        // pre-Multikey type (real for older did:plc documents) must resolve
        // here exactly as it does everywhere else in the network.
        const f = fixture(
            {},
            {
                verificationMethod: [
                    {
                        id: `${DID}#atproto`,
                        type: "EcdsaSecp256k1VerificationKey2019",
                        controller: DID,
                        publicKeyMultibase: SIGNING_KEY,
                    },
                ],
            }
        )
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
        })
        expect(got.signingKey).toBe(SIGNING_KEY)
    })

    it("calls sync.getRecord — never repo.getRecord, which returns JSON", async () => {
        // The relay's own admission check reads JSON deliberately; a
        // monitor cannot, because its output is relayed onward and must
        // carry its own proof.
        const f = fixture()
        await fetchRecordCar(DID, { collection: COLLECTION, fetchImpl: f.impl })
        expect(f.seen.some((u) => u.includes("com.atproto.sync.getRecord"))).toBe(true)
        expect(f.seen.some((u) => u.includes("com.atproto.repo.getRecord"))).toBe(false)
    })

    it("asks the PDS for the rev rather than accepting one from elsewhere", async () => {
        // Taking the stream's rev would let a hostile feed fake a
        // regression alarm, or mask a real one.
        const f = fixture()
        await fetchRecordCar(DID, { collection: COLLECTION, fetchImpl: f.impl })
        expect(f.seen.some((u) => u.includes("sync.getLatestCommit"))).toBe(true)
    })

    it("addresses the record it was asked for", async () => {
        const f = fixture()
        await fetchRecordCar(DID, {
            collection: COLLECTION,
            rkey: "custom",
            fetchImpl: f.impl,
        })
        const url = f.seen.find((u) => u.includes("sync.getRecord")) ?? ""
        expect(url).toContain(`did=${encodeURIComponent(DID)}`)
        expect(url).toContain(`collection=${encodeURIComponent(COLLECTION)}`)
        expect(url).toContain("rkey=custom")
    })

    it("refuses a rev the PDS did not supply", async () => {
        const f = fixture({
            "sync.getLatestCommit": () => Response.json({ cid: "bafy..." }),
        })
        await expect(
            fetchRecordCar(DID, { collection: COLLECTION, fetchImpl: f.impl })
        ).rejects.toThrow(/no rev/)
    })

    it("refuses a DID document that claims a different DID", async () => {
        // Inherited from the shared resolver: a directory handing back
        // someone else's document would otherwise choose the host we then
        // read this DID's key from.
        const f = fixture({
            "plc.directory": () => Response.json({ id: "did:plc:someone-else" }),
        })
        await expect(
            fetchRecordCar(DID, { collection: COLLECTION, fetchImpl: f.impl })
        ).rejects.toThrow(/does not match/)
    })
})

describe("fetchHeadRev", () => {
    it("reads only the DID document and getLatestCommit, returning the PDS's rev", async () => {
        const { impl, seen } = fixture()
        const rev = await fetchHeadRev(DID, { fetchImpl: impl })
        expect(rev).toBeTruthy()
        expect(seen.some((u) => u.includes("sync.getRecord"))).toBe(false)
        expect(seen.filter((u) => u.includes("sync.getLatestCommit"))).toHaveLength(1)
    })

    it("a repo-level terminal answer raises RecordNotFoundError; reversible states are not permanent", async () => {
        for (const [name, permanent] of [
            ["RepoNotFound", true],
            ["RepoDeactivated", false],
            ["RepoTakendown", false],
        ] as const) {
            const { impl } = fixture({
                "sync.getLatestCommit": () =>
                    new Response(JSON.stringify({ error: name }), { status: 400 }),
            })
            const err = await fetchHeadRev(DID, { fetchImpl: impl }).catch((e) => e)
            expect(err).toBeInstanceOf(RecordNotFoundError)
            expect(err.permanent).toBe(permanent)
        }
    })

    it("an unreachable PDS is an ordinary error, not a deletion", async () => {
        const { impl } = fixture({ "sync.getLatestCommit": () => new Response("x", { status: 503 }) })
        const err = await fetchHeadRev(DID, { fetchImpl: impl }).catch((e) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err).not.toBeInstanceOf(RecordNotFoundError)
    })
})

describe("the DID document a fetch resolved through", () => {
    /** A clock the directory's answer advances, so a stamp taken after the request is distinguishable. */
    function clockedFixture() {
        const clock = { now: 1_000 }
        const f = fixture()
        const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).startsWith("https://plc.directory/")) clock.now += 500
            return f.impl(input, init)
        }) as typeof fetch
        return { clock, impl, seen: f.seen }
    }
    const directoryRequests = (seen: string[]) =>
        seen.filter((u) => u.startsWith("https://plc.directory/"))

    it("fetchRecordCar returns the directory's document, stamped with the time before the directory request", async () => {
        const f = clockedFixture()
        const got = await fetchRecordCar(DID, {
            collection: COLLECTION,
            fetchImpl: f.impl,
            nowMs: () => f.clock.now,
        })
        expect(got.didDocument?.fetchedAtMs).toBe(1_000)
        expect(got.didDocument?.document).toMatchObject({
            id: DID,
            service: [{ id: "#atproto_pds", serviceEndpoint: PDS }],
        })
    })

    it("fetchRecordCar resolves the PDS from that same document, one directory request", async () => {
        const f = fixture()
        const got = await fetchRecordCar(DID, { collection: COLLECTION, fetchImpl: f.impl })
        expect(directoryRequests(f.seen)).toHaveLength(1)
        expect(got.source).toBe(PDS)
        expect(got.signingKey).toBe(SIGNING_KEY)
        expect(got.didDocument?.document.id).toBe(DID)
    })

    it("fetchHeadRev hands its document to onDidDocument before reading the head", async () => {
        const f = clockedFixture()
        const events: string[] = []
        const handed: unknown[] = []
        const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes("sync.getLatestCommit")) events.push("head")
            return f.impl(input, init)
        }) as typeof fetch
        await fetchHeadRev(DID, {
            fetchImpl: impl,
            nowMs: () => f.clock.now,
            onDidDocument: async (fetched) => {
                events.push("document")
                handed.push(fetched)
            },
        })
        expect(events).toEqual(["document", "head"])
        expect(handed).toHaveLength(1)
        expect(handed[0]).toMatchObject({ fetchedAtMs: 1_000, document: { id: DID } })
        expect(directoryRequests(f.seen)).toHaveLength(1)
    })

    it("fetchHeadRev waits for onDidDocument to finish before reading the head", async () => {
        const f = fixture()
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const done = fetchHeadRev(DID, {
            fetchImpl: f.impl,
            onDidDocument: () => gate,
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(f.seen.some((u) => u.includes("sync.getLatestCommit"))).toBe(false)
        release()
        await done
        expect(f.seen.some((u) => u.includes("sync.getLatestCommit"))).toBe(true)
    })

    it("fetchHeadRev hands over the document even when it names no PDS", async () => {
        const f = fixture({}, { service: [] })
        const handed: unknown[] = []
        await expect(
            fetchHeadRev(DID, {
                fetchImpl: f.impl,
                onDidDocument: async (fetched) => void handed.push(fetched),
            })
        ).rejects.toThrow(/no #atproto_pds service/)
        expect(handed).toHaveLength(1)
    })

    it("fetchHeadRev without onDidDocument behaves as before", async () => {
        const f = fixture()
        expect(await fetchHeadRev(DID, { fetchImpl: f.impl })).toBe("3mszqbq6s3y2k")
        expect(directoryRequests(f.seen)).toHaveLength(1)
    })

    it("a failing onDidDocument does not fail fetchHeadRev", async () => {
        const f = fixture()
        const rev = await fetchHeadRev(DID, {
            fetchImpl: f.impl,
            onDidDocument: async () => {
                throw new Error("store down")
            },
        })
        expect(rev).toBe("3mszqbq6s3y2k")
    })
})
