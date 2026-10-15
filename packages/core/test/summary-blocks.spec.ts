/** The owner's own blocks in the authenticated summary, and not in the graph. */
import { describe, expect, it } from "vitest"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import {
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    readSummaryPage,
    SUMMARY_DELTA_KEYS,
    type SummaryDelta,
    type SummaryIndex,
} from "../src/summary"

const index = (ownBlocks: SummaryIndex["ownBlocks"]): SummaryIndex => ({
    owner: "did:plc:me",
    ownBlocks,
    records: [],
})
const block = (did: string, rkey: string) => ({ did, rkey })
const deps = {
    records: { get: async () => null },
    signingKeys: { keysFor: async () => new Map() },
}

const delta = (ownBlocks: SummaryDelta["ownBlocks"]): SummaryDelta => ({
    token: "tok",
    full: true,
    ownBlocks,
    records: [],
    removed: [],
    more: false,
    truncated: false,
})

describe("summary — own blocks", () => {
    it("a full summary carries the owner's blocks under b", async () => {
        const current = index([block("did:plc:x", "3k1"), block("did:plc:y", "3k2")])
        const { page } = await readSummaryPage(null, current, deps, 10)
        expect(page.ownBlocks).toEqual(current.ownBlocks)
        const wire = decodeCoseMap(encodeSummaryDelta({ ...delta(current.ownBlocks), ...page, token: "t", truncated: false }))
        expect(SUMMARY_DELTA_KEYS.ownBlocks).toBe("b")
        expect(wire.get("b")).toEqual([
            new Map([["d", "did:plc:x"], ["k", "3k1"]]),
            new Map([["d", "did:plc:y"], ["k", "3k2"]]),
        ])
        const none = await readSummaryPage(null, index([]), deps, 10)
        expect(none.page.ownBlocks).toEqual([])
    })

    it("a delta carries b as null when the owner's blocks are unchanged", async () => {
        const base = index([block("did:plc:x", "3k1")])
        const { page, delivered } = await readSummaryPage(base, index([block("did:plc:x", "3k1")]), deps, 10)
        expect(page.ownBlocks).toBeNull()
        expect(delivered.ownBlocks).toEqual(base.ownBlocks)
        expect(decodeSummaryDelta(encodeSummaryDelta(delta(null))).ownBlocks).toBeNull()
    })

    it("a delta carries the whole block list when any block was added or removed", async () => {
        const base = index([block("did:plc:x", "3k1"), block("did:plc:y", "3k2")])
        for (const next of [
            [block("did:plc:x", "3k1")],
            [block("did:plc:x", "3k1"), block("did:plc:y", "3k2"), block("did:plc:z", "3k3")],
            [block("did:plc:x", "3k1"), block("did:plc:w", "3k2")],
            [block("did:plc:x", "3k1"), block("did:plc:y", "3k9")],
            [],
        ]) {
            expect(diffSummaryIndex(base, index(next)).blocksChanged).toBe(true)
            const { page } = await readSummaryPage(base, index(next), deps, 10)
            expect(page.ownBlocks).toEqual(next)
        }
        expect(diffSummaryIndex(base, index([...base.ownBlocks])).blocksChanged).toBe(false)
        const round = decodeSummaryDelta(encodeSummaryDelta(delta([block("did:plc:x", "3k1")])))
        expect(round.ownBlocks).toEqual([block("did:plc:x", "3k1")])
        expect(decodeSummaryDelta(encodeSummaryDelta(delta([]))).ownBlocks).toEqual([])
    })

    it("decodes a summary without b, as from a relay that predates it", () => {
        const bytes = encodeSummaryDelta(delta(null))
        const map = decodeCoseMap(bytes)
        const stripped = new Map<string, CoseValue>([...map].filter(([k]) => k !== "b") as [string, CoseValue][])
        expect(decodeSummaryDelta(encodeCose(stripped)).ownBlocks).toBeNull()
    })
})
