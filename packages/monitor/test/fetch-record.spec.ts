/**
 * The authoritative read.
 *
 * Every fetch here is against a fixture — the point of injecting `fetch`
 * is that this suite never touches the network. What is pinned is which
 * endpoints are called and what is trusted: CAR from `sync.getRecord`, and
 * the `rev` from the PDS rather than from whatever prompted the read.
 */
import { describe, expect, it } from "vitest"
import { fetchRecordCar } from "../src/fetch-record"

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
                verificationMethod: [
                    {
                        id: "#atproto",
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
