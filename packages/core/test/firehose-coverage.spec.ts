import { describe, expect, it } from "vitest"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import type { PlcCoverage } from "../src/did-document"
import { summaryCoverageAtMs, type FirehoseCoverage } from "../src/firehose-coverage"
import { decodeSummaryDelta, encodeSummaryDelta, type SummaryDelta } from "../src/summary"
import { owner, OWNER, PEER, read, summaryWorld } from "./fixtures/summary-world"

const firehose = (coveredThroughMs: number | null, lagging: string[] = []): FirehoseCoverage => ({
    continuousSinceMs: 1_000,
    coveredThroughMs,
    lagging,
})
const plc = (coveredThroughMs: number, continuousSinceMs = 1_000): PlcCoverage => ({
    url: "wss://plc.example",
    continuousSinceMs,
    coveredThroughMs,
})

describe("summaryCoverageAtMs (S7)", () => {
    it("is the earlier of the firehose and PLC covered-through instants", () => {
        expect(summaryCoverageAtMs(firehose(5_000), plc(7_000))).toBe(5_000)
        expect(summaryCoverageAtMs(firehose(9_000), plc(7_000))).toBe(7_000)
    })

    it("is null when either watermark is missing, the firehose one is null, or the PLC run ended", () => {
        expect(summaryCoverageAtMs(null, plc(7_000))).toBeNull()
        expect(summaryCoverageAtMs(firehose(5_000), null)).toBeNull()
        expect(summaryCoverageAtMs(firehose(null), plc(7_000))).toBeNull()
        expect(summaryCoverageAtMs(firehose(500), plc(7_000))).toBeNull()
        expect(summaryCoverageAtMs(firehose(5_000), plc(500))).toBeNull()
    })
})

describe("summary w and l (S7)", () => {
    const withCoverage = async (lagging: string[] = []) => {
        const w = summaryWorld()
        w.coverage.firehose = firehose(5_000, lagging)
        w.coverage.plc = plc(7_000)
        return { w, get: await owner(w, OWNER) }
    }

    it("encodes the spec's updated summary vector byte for byte (11 keys)", async () => {
        // Pinned against the hand-assembled bytes in summary-mutual.spec.ts; here the key count.
        const delta: SummaryDelta = {
            token: "abc",
            full: false,
            ownBlocks: null,
            records: [],
            removed: [],
            verdicts: [],
            droppedVerdicts: [],
            more: false,
            truncated: false,
            coveredThroughMs: 1_700_000_000_000,
            lagging: ["did:plc:b"],
        }
        expect([...decodeCoseMap(encodeSummaryDelta(delta)).keys()].sort()).toEqual(
            ["b", "c", "f", "l", "m", "n", "r", "t", "w", "x", "y"]
        )
        expect(decodeSummaryDelta(encodeSummaryDelta(delta))).toEqual(delta)
    })

    it("carries w and l on every 200, including an unchanged token", async () => {
        const { get } = await withCoverage([PEER])
        const first = await read(await get())
        const second = await read(await get(first.token))
        expect(second.token).toBe(first.token)
        for (const d of [first, second]) {
            expect(d.coveredThroughMs).toBe(5_000)
            expect(d.lagging).toEqual([PEER])
        }
    })

    it("carries w and l on every page of a multi-page response", async () => {
        const w = summaryWorld()
        w.coverage.firehose = firehose(5_000)
        w.coverage.plc = plc(7_000)
        w.deps.pageRecords = 1
        const get = await owner(w, OWNER)
        const page1 = await read(await get())
        expect(page1.more).toBe(true)
        const page2 = await read(await get(page1.token))
        expect([page1, page2].map((d) => d.coveredThroughMs)).toEqual([5_000, 5_000])
    })

    it("is null when coverage is missing, unreadable or the firehose has none", async () => {
        const w = summaryWorld()
        const get = await owner(w, OWNER)
        expect((await read(await get())).coveredThroughMs).toBeNull()
        w.coverage.plc = plc(7_000)
        w.coverage.firehose = firehose(null, [PEER])
        const noFirehose = await read(await get())
        expect(noFirehose.coveredThroughMs).toBeNull()
        w.coverage.firehose = firehose(5_000)
        w.coverage.fail = true
        const unreadable = await read(await get())
        expect(unreadable.coveredThroughMs).toBeNull()
        expect(unreadable.lagging).toEqual([])
    })

    it("reads coverage before the index and any CAR", async () => {
        const { w, get } = await withCoverage()
        await get()
        expect(w.order[0]).toBe("coverage")
        expect(w.order.indexOf("coverage")).toBeLessThan(w.order.indexOf("index"))
        expect(w.order.indexOf("coverage")).toBeLessThan(w.order.indexOf("car"))
    })

    it("l lists only this summary's truncated contacts that are lagging, sorted, empty when none", async () => {
        const zed = "did:plc:zzz0000000000000000000"
        const aaa = "did:plc:aaa0000000000000000000"
        const w = summaryWorld()
        w.coverage.firehose = firehose(5_000, [zed, aaa, OWNER])
        w.coverage.plc = plc(7_000)
        w.ownGraphs.set(OWNER, {
            did: OWNER,
            following: [
                { did: zed, mutual: true },
                { did: aaa, mutual: false },
            ],
            followers: [{ did: zed, mutual: true }],
        })
        const get = await owner(w, OWNER)
        expect((await read(await get())).lagging).toEqual([aaa, zed])
        w.coverage.firehose = firehose(5_000, [])
        expect((await read(await get())).lagging).toEqual([])
    })

    it("leaves a lagging contact out when the summary truncates it", async () => {
        const kept = "did:plc:aaa0000000000000000000"
        const cut = "did:plc:zzz0000000000000000000"
        const w = summaryWorld({
            watched: Array.from({ length: 3_000 }, (_, i) => ({ collection: `app.example.t${i}`, rkey: "self" })),
        })
        w.coverage.firehose = firehose(5_000, [kept, cut])
        w.coverage.plc = plc(7_000)
        w.ownGraphs.set(OWNER, {
            did: OWNER,
            following: [
                { did: kept, mutual: false },
                { did: cut, mutual: false },
            ],
            followers: [],
        })
        const delta = await read(await (await owner(w, OWNER))())
        expect(delta.truncated).toBe(true)
        expect(delta.lagging).toEqual([kept])
    })

    it("never lists a lagging DID outside the owner's contacts", async () => {
        const { get } = await withCoverage(["did:plc:stranger0000000000000", PEER])
        const delta = await read(await get())
        expect(delta.lagging).toEqual([PEER])
    })

    it("an old decoder ignores w and l", async () => {
        const { get } = await withCoverage([PEER])
        const wire = decodeCoseMap(new Uint8Array(await (await get()).arrayBuffer()))
        wire.delete("w")
        wire.delete("l")
        const old = decodeSummaryDelta(encodeCose(wire as CoseValue))
        expect(old.coveredThroughMs).toBeNull()
        expect(old.lagging).toEqual([])
        // And a body with them decodes under a decoder that never looks at them.
        const full = decodeSummaryDelta(new Uint8Array(await (await get()).arrayBuffer()))
        expect(full.coveredThroughMs).toBe(5_000)
    })

    it("rejects a malformed w or l", () => {
        const base = (): Map<string, CoseValue> =>
            new Map<string, CoseValue>([
                ["t", "t"],
                ["f", true],
                ["r", []],
                ["x", []],
            ])
        for (const [k, v] of [
            ["w", "5"],
            ["w", -1],
            ["l", [1]],
            ["l", "did:plc:a"],
        ] as const) {
            const m = base()
            m.set(k, v as CoseValue)
            expect(() => decodeSummaryDelta(encodeCose(m))).toThrow()
        }
    })
})
