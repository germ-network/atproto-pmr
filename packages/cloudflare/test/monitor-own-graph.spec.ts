/** The owner's graph through the relay's RPC adapter. */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { PMREnv } from "../src/env"
import { monitorOwnGraph } from "../src/monitor-own-graph"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"

const testEnv = env as unknown as PMREnv<PMRObject>

let didCounter = 0
const freshDID = () => `did:plc:own-graph-${(didCounter += 1)}`

function ingest() {
    const ns = testEnv.MONITOR_INGEST!
    return ns.get(ns.idFromName(testEnv.MONITOR_INGEST_NAME!)) as unknown as DurableObjectStub<MonitorIngestStub>
}

describe("monitorOwnGraph", () => {
    it("forwards to the ingest object's ownGraph, null included", async () => {
        const served = freshDID()
        const unserved = freshDID()
        const graph = {
            did: served,
            following: [{ did: "did:plc:x", mutual: true }],
            followers: [],
        }
        await ingest().setOwnGraph(served, graph)
        await ingest().setOwnGraph(unserved, null)
        const source = monitorOwnGraph(testEnv)
        expect(await source.ownGraph(served)).toEqual(graph)
        expect(await source.ownGraph(unserved)).toBeNull()
    })

    it("throws when no monitor is bound or the call fails", async () => {
        const did = freshDID()
        for (const unbound of [
            { ...testEnv, MONITOR_INGEST: undefined },
            { ...testEnv, MONITOR_INGEST_NAME: undefined },
        ]) {
            await expect(monitorOwnGraph(unbound).ownGraph(did)).rejects.toThrow(/no monitor/)
        }
        await ingest().setOwnGraph(did, "throw")
        await expect(monitorOwnGraph(testEnv).ownGraph(did)).rejects.toThrow(/monitor down/)
    })
})
