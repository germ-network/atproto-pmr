/** The owner's own blocks through the relay: the RPC adapter and the stored summary baseline. */
import { env } from "cloudflare:test"
import {
    buildSummaryIndex,
    diffSummaryIndex,
    readSummaryPage,
    SummaryOwnBlocksError,
    type SummaryIndex,
    type SummaryPageDeps,
} from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import { inPMR } from "./helpers"
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

const baseline = (ownBlocks: SummaryIndex["ownBlocks"]): SummaryIndex => ({
    graph: { did: "did:plc:me", following: [], followers: [] },
    ownBlocks,
    records: [],
})

let pmrCounter = 0
const freshPMR = (): DurableObjectStub<PMRObject> => {
    pmrCounter += 1
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`own-blocks-${pmrCounter}`))
}
const summaryDeps = (did: string) =>
    ({
        projections: { get: async () => ({ did, following: [], followers: [] }) },
        blocks: monitorOwnBlocks(testEnv),
        index: { entries: async () => [] },
        records: { get: async () => null },
        signingKeys: { keysFor: async () => new Map() },
        watched: [],
        onLapse: () => {},
        nowMs: () => 1,
    }) satisfies SummaryPageDeps

describe("summary read — own blocks", () => {
    it("a stored baseline holds the owner's blocks, so an unchanged list reads back as b null", async () => {
        const did = freshDID()
        const blocks = [{ blocker: did, rkey: "3k1", subject: "did:plc:x" }]
        await ingest().setOwnBlocks(did, blocks)
        const built = (await buildSummaryIndex(did, summaryDeps(did)))!
        await inPMR(freshPMR(), async (pmr) => {
            await pmr.putSummaryIndex("t1", built.index, 1000)
            const held = await pmr.getSummaryIndex("t1")
            expect(held!.ownBlocks).toEqual([{ did: "did:plc:x", rkey: "3k1" }])
            const { page } = await readSummaryPage(held, built.index, summaryDeps(did), 10)
            expect(page.ownBlocks).toBeNull()
        })
    })

    it("a baseline's block list larger than one storage part round-trips", async () => {
        const long = (i: number) => ({ did: `did:plc:${String(i).padStart(6, "0")}${"x".repeat(2000)}`, rkey: `k${i}` })
        const many = Array.from({ length: 700 }, (_, i) => long(i))
        await inPMR(freshPMR(), async (pmr) => {
            await pmr.putSummaryIndex("big", baseline(many), 1000)
            expect((await pmr.getSummaryIndex("big"))!.ownBlocks).toEqual(many)
        })
    })

    it("a change to blocks alone diffs as blocksChanged", async () => {
        const did = freshDID()
        await ingest().setOwnBlocks(did, [])
        const first = (await buildSummaryIndex(did, summaryDeps(did)))!
        await ingest().setOwnBlocks(did, [{ blocker: did, rkey: "3k1", subject: "did:plc:x" }])
        const second = (await buildSummaryIndex(did, summaryDeps(did)))!
        const diff = diffSummaryIndex(first.index, second.index)
        expect(diff).toMatchObject({ blocksChanged: true, graphChanged: false, changed: [], removed: [] })
    })

    it("a failed blocks read over the RPC rejects with SummaryOwnBlocksError and touches no baseline", async () => {
        const did = freshDID()
        await ingest().setOwnBlocks(did, "throw")
        await inPMR(freshPMR(), async (pmr) => {
            await pmr.putSummaryIndex("t1", baseline([{ did: "did:plc:x", rkey: "3k1" }]), 1000)
            await expect(buildSummaryIndex(did, summaryDeps(did))).rejects.toBeInstanceOf(SummaryOwnBlocksError)
            expect((await pmr.getSummaryIndex("t1"))!.ownBlocks).toEqual([{ did: "did:plc:x", rkey: "3k1" }])
        })
    })

    it("an unserved graph builds no index and touches no baseline", async () => {
        const did = freshDID()
        await ingest().setOwnBlocks(did, null)
        await inPMR(freshPMR(), async (pmr) => {
            await pmr.putSummaryIndex("t1", baseline([{ did: "did:plc:x", rkey: "3k1" }]), 1000)
            expect(await buildSummaryIndex(did, summaryDeps(did))).toBeNull()
            expect(await pmr.getSummaryIndex("t1")).not.toBeNull()
        })
    })
})
