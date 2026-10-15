/** The ingest object's RPC the owner's summary reads blocks through. */
import { beforeEach, describe, expect, it } from "vitest"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import { statementBudget } from "../src/follow-edge-store"
import { clearGraph, db, inObj, registeredStub } from "./listing-harness"

beforeEach(async () => {
    await clearGraph()
    await db.exec("DELETE FROM blocks")
})

const put = (blocker: string, rkey: string, subject: string) =>
    d1BlockEdgeWriter(db, statementBudget(100)).putBlocks([{ blocker, rkey, subject }], 1)

describe("MonitorIngest.ownBlocks", () => {
    it("returns a served owner's blocks from D1", async () => {
        await db.prepare("INSERT INTO graph_owners (did) VALUES ('did:o')").run()
        await put("did:o", "b", "did:y")
        await put("did:o", "a", "did:x")
        await put("did:other", "a", "did:x")
        expect(await inObj(registeredStub("rpc"), (obj) => obj.ownBlocks("did:o"))).toEqual([
            { blocker: "did:o", rkey: "a", subject: "did:x" },
            { blocker: "did:o", rkey: "b", subject: "did:y" },
        ])
    })

    it("answers over the Durable Object RPC boundary", async () => {
        await db.prepare("INSERT INTO graph_owners (did) VALUES ('did:o')").run()
        await put("did:o", "a", "did:x")
        expect(await registeredStub("rpc").ownBlocks("did:o")).toEqual([
            { blocker: "did:o", rkey: "a", subject: "did:x" },
        ])
    })

    it("returns null for a DID whose graph is not served", async () => {
        await put("did:o", "a", "did:x")
        expect(await inObj(registeredStub("rpc"), (obj) => obj.ownBlocks("did:o"))).toBeNull()
    })

    it("returns [] for a served owner with no blocks", async () => {
        await db.prepare("INSERT INTO graph_owners (did) VALUES ('did:o')").run()
        expect(await inObj(registeredStub("rpc"), (obj) => obj.ownBlocks("did:o"))).toEqual([])
    })

    it("rejects when D1 cannot answer, rather than answering empty", async () => {
        await expect(
            inObj(registeredStub("rpc"), async (obj) => {
                ;(obj as unknown as { env: unknown }).env = { ...obj.env, graph: undefined }
                return obj.ownBlocks("did:o")
            })
        ).rejects.toThrow(TypeError)
    })
})
