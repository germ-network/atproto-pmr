/** The owner's summary carries computed results only: no follow graph in the delta or its baseline. */
import { describe, expect, it } from "vitest"
import { decodeCoseMap } from "../src/cose/cbor"
import {
    buildSummaryIndex,
    diffSummaryIndex,
    encodeSummaryDelta,
    SUMMARY_DELTA_KEYS,
    type SummaryDelta,
    type SummaryPageDeps,
} from "../src/summary"
import type { OwnerGraph } from "../src/owner-graph"

const OWNER = "did:plc:owner"
const COLL = "app.example.thing"

const graphOf = (following: string[], followers: string[] = []): OwnerGraph => ({
    did: OWNER,
    following: following.map((did) => ({ did, mutual: false })),
    followers: followers.map((did) => ({ did, mutual: false })),
})

/** A world where only the DIDs in `held` have a record. */
const depsFor = (graph: OwnerGraph, held: string[]): SummaryPageDeps => ({
    graph: { ownGraph: async () => graph },
    blocks: { ownBlocks: async () => [{ blocker: OWNER, rkey: "b1", subject: "did:plc:blocked" }] },
    index: {
        entries: async (refs) =>
            refs.map((r) =>
                held.includes(r.did) ? { ...r, cid: `cid-${r.did}`, verifiedWith: "k", freshAtMs: 0 } : null
            ),
    },
    records: { get: async () => null },
    signingKeys: { keysFor: async (dids) => new Map(dids.map((d) => [d, { kind: "trusted", key: "k" } as const])) },
    watched: [{ collection: COLL, rkey: "self" }],
    onLapse: () => {},
    nowMs: () => 0,
})

const build = async (graph: OwnerGraph, held: string[]) =>
    (await buildSummaryIndex(OWNER, depsFor(graph, held)))!.index

describe("summary without a graph", () => {
    it("an encoded delta never carries the retired graph key \"g\"", () => {
        const delta: SummaryDelta = {
            token: "t",
            full: true,
            ownBlocks: [{ did: "did:plc:x", rkey: "r" }],
            records: [],
            removed: [],
            more: false,
            truncated: false,
        }
        expect([...decodeCoseMap(encodeSummaryDelta(delta)).keys()]).not.toContain("g")
        expect(Object.values(SUMMARY_DELTA_KEYS)).not.toContain("g")
    })

    it("a summary index holds the owner, the owner's blocks and record entries, and no edges", async () => {
        const index = await build(graphOf(["did:plc:a"], ["did:plc:b"]), [OWNER, "did:plc:a"])
        expect(Object.keys(index).sort()).toEqual(["ownBlocks", "owner", "records"])
        expect(index.owner).toBe(OWNER)
        expect(index.ownBlocks).toEqual([{ did: "did:plc:blocked", rkey: "b1" }])
        expect(index.records.map((r) => r.did)).toEqual(["did:plc:a", OWNER])
    })

    it("a follow change that leaves the covered records unchanged yields an unchanged delta", async () => {
        const held = [OWNER, "did:plc:a"]
        const before = await build(graphOf(["did:plc:a"]), held)
        const after = await build(graphOf(["did:plc:a", "did:plc:nodecl"], ["did:plc:also"]), held)
        expect(diffSummaryIndex(before, after)).toEqual({
            full: false,
            blocksChanged: false,
            changed: [],
            removed: [],
        })
    })

    it("a contact leaving the graph shows only as removal of its records", async () => {
        const held = [OWNER, "did:plc:a"]
        const before = await build(graphOf(["did:plc:a"]), held)
        const after = await build(graphOf([]), held)
        expect(diffSummaryIndex(before, after)).toEqual({
            full: false,
            blocksChanged: false,
            changed: [],
            removed: [{ did: "did:plc:a", collection: COLL, rkey: "self" }],
        })
    })
})
