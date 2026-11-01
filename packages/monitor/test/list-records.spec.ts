import { describe, expect, it } from "vitest"
import { listEdgeRecords } from "../src/list-records"

const DID = "did:plc:alice"
const PDS = "https://pds.example"

const uri = (rkey: string) => `at://${DID}/app.bsky.graph.follow/${rkey}`

function pdsReturning(body: unknown) {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return Response.json(body)
    }) as typeof fetch
    return { seen, fetchImpl }
}

describe("listEdgeRecords", () => {
    it("requests the block collection when asked for blocks", async () => {
        const f = pdsReturning({
            records: [{ uri: "at://did:plc:alice/app.bsky.graph.block/3k1", value: { subject: "did:plc:b" } }],
        })
        const page = await listEdgeRecords(DID, "block", null, { pds: PDS, fetchImpl: f.fetchImpl })
        expect(new URL(f.seen[0]!).searchParams.get("collection")).toBe("app.bsky.graph.block")
        expect(page.records).toEqual([{ rkey: "3k1", subject: "did:plc:b" }])
    })

    it("requests the follow collection at the PDS, ascending, after the given rkey", async () => {
        const f = pdsReturning({
            records: [{ uri: uri("a"), value: { subject: "did:plc:bob" } }],
            cursor: "a",
        })
        const page = await listEdgeRecords(DID, "follow", "9", { pds: PDS, fetchImpl: f.fetchImpl })
        const url = new URL(f.seen[0]!)
        expect(url.origin + url.pathname).toBe(`${PDS}/xrpc/com.atproto.repo.listRecords`)
        expect(Object.fromEntries(
            ["repo", "collection", "limit", "reverse", "cursor"].map((k) => [k, url.searchParams.get(k)])
        )).toEqual({
            repo: DID,
            collection: "app.bsky.graph.follow",
            limit: "100",
            reverse: "true",
            cursor: "9",
        })
        expect(page).toEqual({ records: [{ rkey: "a", subject: "did:plc:bob" }], lastRkey: "a" })

        const first = pdsReturning({ records: [] })
        const empty = await listEdgeRecords(DID, "follow", null, { pds: PDS, limit: 10, fetchImpl: first.fetchImpl })
        const params = new URL(first.seen[0]!).searchParams
        expect(params.has("cursor")).toBe(false)
        expect(params.get("limit")).toBe("10")
        expect(empty).toEqual({ records: [], lastRkey: null })
    })

    it("a record without a string subject is skipped", async () => {
        const f = pdsReturning({
            records: [
                { uri: uri("a"), value: { subject: 7 } },
                { uri: uri("b"), value: { subject: "did:plc:bob" } },
                { uri: uri("c"), value: {} },
            ],
        })
        const page = await listEdgeRecords(DID, "follow", null, { pds: PDS, fetchImpl: f.fetchImpl })
        expect(page.records).toEqual([{ rkey: "b", subject: "did:plc:bob" }])
    })

    it("a page of only malformed records still returns its last rkey", async () => {
        const f = pdsReturning({
            records: [
                { uri: uri("a"), value: {} },
                { uri: uri("b"), value: { subject: null } },
            ],
        })
        expect(await listEdgeRecords(DID, "follow", null, { pds: PDS, fetchImpl: f.fetchImpl })).toEqual({
            records: [],
            lastRkey: "b",
        })
    })

    it("refuses a non-https PDS", async () => {
        const f = pdsReturning({ records: [] })
        await expect(
            listEdgeRecords(DID, "follow", null, { pds: "http://pds.example", fetchImpl: f.fetchImpl })
        ).rejects.toThrow(/non-https/)
        expect(f.seen).toEqual([])
    })
})
