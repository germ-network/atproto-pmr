/**
 * GET /pmr/v1/requests lists request mailboxes by DID and entry ids, so the
 * device judges a sender before downloading anything.
 */
import { describe, expect, it } from "vitest"
import type { BlockEdge } from "../src/block-edges"
import { handleRequestsList } from "../src/owner/endpoints"
import type { PMRStore, RequestMailbox } from "../src/storage"
import { cborMap, ORIGIN, ownerWorld, OWNER } from "./owner-harness"

const PAGE = 2
const edge = (subject: string): BlockEdge => ({ blocker: OWNER, rkey: subject, subject })

function requestStore(entries: RequestMailbox[] = [], nextCursor: string | null = null, log: string[] = []) {
    const calls: Array<[string | null, number]> = []
    const store = {
        syncBskyBlocks: async () => void log.push("sync"),
        requestMailboxes: async (cursor: string | null, limit: number) => {
            log.push("requestMailboxes")
            calls.push([cursor, limit])
            return { entries, nextCursor }
        },
    } as unknown as Partial<PMRStore>
    return { store, calls, log }
}

async function world(stub: Partial<PMRStore>) {
    const blocks = { ownBlocks: async () => [edge("did:plc:blocked")] }
    return ownerWorld(stub, {
        blocks,
        catchUpPageMailboxes: PAGE,
        challengeConfig: { ttlSeconds: 600, byteLength: 32 },
        randomBytes: (n: number) => new Uint8Array(n).fill(7),
    } as never)
}

const list = async (w: Awaited<ReturnType<typeof world>>, path = "/pmr/v1/requests") =>
    handleRequestsList(await w.request(path), w.deps as never)

describe("handleRequestsList", () => {
    it("answers {rq: [{k, id}], n} from requestMailboxes, ids oldest first", async () => {
        const { store } = requestStore(
            [
                { key: "did:plc:a", messageIds: ["a1", "a2"] },
                { key: "did:plc:b", messageIds: ["b1"] },
            ],
            "did:plc:b"
        )
        const response = await list(await world(store))
        expect(response.status).toBe(200)
        const page = await cborMap(response)
        const rows = page.get("rq") as Map<string, unknown>[]
        expect(rows.map((row) => [row.get("k"), row.get("id")])).toEqual([
            ["did:plc:a", ["a1", "a2"]],
            ["did:plc:b", ["b1"]],
        ])
        expect(page.get("n")).toBe("did:plc:b")
        expect([...page.keys()].sort()).toEqual(["n", "rq"])
        expect(response.headers.get("Germ-Next-Challenge")).not.toBeNull()
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("content-type")).toBe("application/cbor")

        const last = requestStore([{ key: "did:plc:a", messageIds: ["a1"] }], null)
        expect((await cborMap(await list(await world(last.store)))).get("n")).toBeNull()
        const none = requestStore()
        expect((await cborMap(await list(await world(none.store)))).get("rq")).toEqual([])
    })

    it("carries no relay verdict or reason on a row", async () => {
        const { store } = requestStore([
            { key: "did:plc:a", messageIds: ["a1"], verdict: "no", why: ["not-admitted"] } as unknown as RequestMailbox,
        ])
        const rows = (await cborMap(await list(await world(store)))).get("rq") as Map<string, unknown>[]
        expect([...rows[0]!.keys()].sort()).toEqual(["id", "k"])
    })

    it("passes the cursor through and pages by catchUpPageMailboxes", async () => {
        const { store, calls } = requestStore()
        const w = await world(store)
        await list(w, "/pmr/v1/requests")
        await list(w, "/pmr/v1/requests?cursor=")
        await list(w, "/pmr/v1/requests?cursor=req%3Adid%3Aplc%3Ab")
        expect(calls).toEqual([
            [null, PAGE],
            [null, PAGE],
            ["req:did:plc:b", PAGE],
        ])
    })

    it("mirrors the owner's Bsky blocks before the first page (no cursor or an empty one) and not on later pages", async () => {
        const log: string[] = []
        const { store } = requestStore([], null, log)
        const w = await world(store)
        await list(w, "/pmr/v1/requests")
        expect(log).toEqual(["sync", "requestMailboxes"])
        log.length = 0
        await list(w, "/pmr/v1/requests?cursor=")
        expect(log).toEqual(["sync", "requestMailboxes"])
        log.length = 0
        await list(w, "/pmr/v1/requests?cursor=did:plc:b")
        expect(log).toEqual(["requestMailboxes"])
    })

    it("refuses an unauthenticated request like any owner endpoint", async () => {
        const log: string[] = []
        const { store, calls } = requestStore([], null, log)
        const w = await world(store)
        const response = await handleRequestsList(new Request(`${ORIGIN}/pmr/v1/requests`), w.deps as never)
        expect(response.status).toBe(401)
        expect(response.headers.get("Germ-Next-Challenge")).toBeNull()
        expect(calls).toEqual([])
        expect(log).toEqual([])
    })
})
