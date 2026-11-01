/**
 * The summary chooses its contacts from the owner's private graph source,
 * which never reaches a device. The 409 and 503 answers are pinned at the
 * endpoint in summary.spec.ts.
 */
import { describe, expect, it } from "vitest"
import type { OwnerGraph } from "../src/owner-graph"
import { buildSummaryIndex, SummaryOwnerReadError, type SummaryPageDeps } from "../src/summary"

const OWNER = "did:plc:owner"
const COLL = "app.example.thing"

const graph: OwnerGraph = {
    did: OWNER,
    following: [
        { did: "did:plc:f", mutual: false },
        { did: "did:plc:m", mutual: true },
    ],
    followers: [{ did: "did:plc:g", mutual: false }],
}

function depsFor(
    ownGraph: SummaryPageDeps["graph"]["ownGraph"],
    ownBlocks: SummaryPageDeps["blocks"]["ownBlocks"] = async () => []
) {
    const asked: string[][] = []
    const deps: SummaryPageDeps = {
        getFirehoseCoverage: async () => null,
        getPlcCoverage: async () => null,
        graph: { ownGraph },
        blocks: { ownBlocks },
        senderGraph: { forSender: async () => new Map() },
        index: {
            entries: async (refs) => {
                asked.push([...new Set(refs.map((r) => r.did))])
                return refs.map(() => null)
            },
        },
        records: { get: async () => null },
        signingKeys: { keysFor: async () => new Map() },
        watched: [{ collection: COLL, rkey: "self" }],
        onLapse: () => {},
        nowMs: () => 0,
    }
    return { deps, asked }
}

describe("summary contacts from ownGraph", () => {
    it("covers the owner, then mutuals, following and followers from deps.graph.ownGraph", async () => {
        const w = depsFor(async () => graph)
        await buildSummaryIndex(OWNER, w.deps)
        expect(w.asked).toEqual([[OWNER, "did:plc:m", "did:plc:f", "did:plc:g"]])
    })

    it("builds no index for an unserved graph, and reports a failed read as SummaryOwnerReadError", async () => {
        expect(await buildSummaryIndex(OWNER, depsFor(async () => null).deps)).toBeNull()
        const failing = depsFor(async () => {
            throw new Error("d1 down")
        })
        await expect(buildSummaryIndex(OWNER, failing.deps)).rejects.toBeInstanceOf(SummaryOwnerReadError)
        expect(failing.asked).toEqual([])
    })

    // Each read resolves only once the other has been called, so a build that
    // awaits either first hangs.
    it("reads the graph and the owner's blocks concurrently", async () => {
        let blocksCalled!: () => void
        let graphCalled!: () => void
        const blocksStarted = new Promise<void>((resolve) => (blocksCalled = resolve))
        const graphStarted = new Promise<void>((resolve) => (graphCalled = resolve))
        const w = depsFor(
            async () => {
                graphCalled()
                await blocksStarted
                return graph
            },
            async () => {
                blocksCalled()
                await graphStarted
                return []
            }
        )
        const built = await Promise.race([
            buildSummaryIndex(OWNER, w.deps),
            new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
        ])
        expect(built).not.toBe("hung")
        expect(w.asked).toHaveLength(1)
    })
})
