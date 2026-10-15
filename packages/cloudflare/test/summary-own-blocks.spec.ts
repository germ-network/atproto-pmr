/** The owner's own blocks through the relay: the RPC adapter and the stored summary baseline. */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { PMREnv } from "../src/env"
import { monitorOwnBlocks } from "../src/monitor-own-blocks"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"

const testEnv = env as unknown as PMREnv<PMRObject>

let didCounter = 0
const freshDID = () => `did:plc:own-blocks-${(didCounter += 1)}`

function ingest() {
    const ns = testEnv.MONITOR_INGEST!
    return ns.get(ns.idFromName(testEnv.MONITOR_INGEST_NAME!)) as unknown as DurableObjectStub<MonitorIngestStub>
}

describe("monitorOwnBlocks", () => {
    it("forwards to the ingest object's ownBlocks", async () => {
        const served = freshDID()
        const unserved = freshDID()
        const blocks = [{ blocker: served, rkey: "3k1", subject: "did:plc:x" }]
        await ingest().setOwnBlocks(served, blocks)
        await ingest().setOwnBlocks(unserved, null)
        const store = monitorOwnBlocks(testEnv)
        expect(await store.ownBlocks(served)).toEqual(blocks)
        expect(await store.ownBlocks(unserved)).toBeNull()
    })

    it("throws when no monitor is bound or the call fails", async () => {
        const did = freshDID()
        for (const unbound of [
            { ...testEnv, MONITOR_INGEST: undefined },
            { ...testEnv, MONITOR_INGEST_NAME: undefined },
        ]) {
            await expect(monitorOwnBlocks(unbound).ownBlocks(did)).rejects.toThrow(/no monitor/)
        }
        await ingest().setOwnBlocks(did, "throw")
        await expect(monitorOwnBlocks(testEnv).ownBlocks(did)).rejects.toThrow(/monitor down/)
    })
})

describe("summary read — own blocks", () => {
    it.todo("a stored baseline holds the owner's blocks, so an unchanged list reads back as b null")
    it.todo("a change to blocks alone issues a new token")
    it.todo("answers 503 when the owner's blocks cannot be read, keeping the held baseline")
    it.todo("answers 409 when the owner's graph is not served, keeping the held baseline")
})
