import { describe, expect, it } from "vitest"
import {
    computeFirehoseCoverage,
    isResumeJump,
    isStaleCursor,
    streamTimeUs,
    type FirehoseCoverageInput,
    type OwedStreamEvent,
} from "../src/firehose-coverage"

const NOW = 1_700_000_000_000
const MIN = 60_000
const us = (ms: number) => ms * 1000

const base: FirehoseCoverageInput = {
    cursorUs: us(NOW - 1000),
    owed: [],
    continuousSinceMs: NOW - 60 * MIN,
    nowMs: NOW,
    maxLagMs: 10 * MIN,
    kvVisibilityMs: 60_000,
    laggingCap: 3,
}

const owedAt = (did: string, ms: number): OwedStreamEvent => ({
    did,
    owedSinceUs: us(ms),
    appliedAtMs: null,
})

describe("computeFirehoseCoverage (S4)", () => {
    it("is the cursor time when nothing is owed", () => {
        expect(computeFirehoseCoverage(base)).toEqual({
            continuousSinceMs: NOW - 60 * MIN,
            coveredThroughMs: NOW - 1000,
            lagging: [],
        })
    })

    it("is held back to the oldest owed event within the lag bound", () => {
        const got = computeFirehoseCoverage({
            ...base,
            owed: [owedAt("did:plc:b", NOW - 5 * MIN), owedAt("did:plc:a", NOW - 2 * MIN)],
        })
        expect(got.coveredThroughMs).toBe(NOW - 5 * MIN)
        expect(got.lagging).toEqual([])
    })

    it("is held back by a fetch applied within the KV visibility window", () => {
        const applied: OwedStreamEvent = {
            did: "did:plc:a",
            owedSinceUs: us(NOW - 3 * MIN),
            appliedAtMs: NOW - 10_000,
        }
        expect(computeFirehoseCoverage({ ...base, owed: [applied] }).coveredThroughMs).toBe(
            NOW - 3 * MIN
        )
        const visible = { ...applied, appliedAtMs: NOW - 60_000 }
        expect(computeFirehoseCoverage({ ...base, owed: [visible] }).coveredThroughMs).toBe(
            NOW - 1000
        )
    })

    it("moves a DID whose owed event is older than the lag bound to the lagging list, releasing the watermark", () => {
        const got = computeFirehoseCoverage({
            ...base,
            owed: [owedAt("did:plc:old", NOW - 11 * MIN), owedAt("did:plc:new", NOW - MIN)],
        })
        expect(got.lagging).toEqual(["did:plc:old"])
        expect(got.coveredThroughMs).toBe(NOW - MIN)
        const edge = computeFirehoseCoverage({
            ...base,
            owed: [owedAt("did:plc:edge", NOW - 10 * MIN)],
        })
        expect(edge.lagging).toEqual([])
        expect(edge.coveredThroughMs).toBe(NOW - 10 * MIN)
    })

    it("a lagging DID that settles leaves the list and the watermark moves", () => {
        const owed = owedAt("did:plc:old", NOW - 11 * MIN)
        const before = computeFirehoseCoverage({ ...base, owed: [owed] })
        expect(before.lagging).toEqual(["did:plc:old"])
        const after = computeFirehoseCoverage({
            ...base,
            owed: [{ ...owed, appliedAtMs: NOW - 90_000 }],
        })
        expect(after.lagging).toEqual([])
        expect(after.coveredThroughMs).toBe(NOW - 1000)
        const justApplied = computeFirehoseCoverage({
            ...base,
            owed: [{ ...owed, appliedAtMs: NOW - 1000 }],
        })
        expect(justApplied.lagging).toEqual(["did:plc:old"])
        expect(justApplied.coveredThroughMs).toBe(NOW - 1000)
    })

    it("a row stamped 0 lags at once", () => {
        const got = computeFirehoseCoverage({
            ...base,
            owed: [{ did: "did:plc:legacy", owedSinceUs: 0, appliedAtMs: null }],
        })
        expect(got.lagging).toEqual(["did:plc:legacy"])
        expect(got.coveredThroughMs).toBe(NOW - 1000)
    })

    it("a catch-up backlog over the cap gives null coverage", () => {
        const four = ["d", "c", "b", "a"].map((x) => owedAt(`did:plc:${x}`, NOW - 30 * MIN))
        const over = computeFirehoseCoverage({ ...base, owed: four })
        expect(over.coveredThroughMs).toBeNull()
        expect(over.lagging).toEqual(["did:plc:a", "did:plc:b", "did:plc:c", "did:plc:d"])
        const atCap = computeFirehoseCoverage({ ...base, owed: four.slice(0, 3) })
        expect(atCap.coveredThroughMs).toBe(NOW - 1000)
    })

    it("is null while covered-through is before the run start, and before a cursor exists", () => {
        expect(
            computeFirehoseCoverage({
                ...base,
                continuousSinceMs: NOW - 2 * MIN,
                owed: [owedAt("did:plc:a", NOW - 5 * MIN)],
            }).coveredThroughMs
        ).toBeNull()
        expect(
            computeFirehoseCoverage({ ...base, continuousSinceMs: NOW - 1000 }).coveredThroughMs
        ).toBe(NOW - 1000)
        expect(computeFirehoseCoverage({ ...base, cursorUs: null }).coveredThroughMs).toBeNull()
        expect(
            computeFirehoseCoverage({ ...base, cursorUs: null, continuousSinceMs: 0 }).coveredThroughMs
        ).toBeNull()
    })

    it("counts a DID's stamps once, whichever of its rows is older, and excuses all of a lagging DID's", () => {
        const got = computeFirehoseCoverage({
            ...base,
            owed: [
                owedAt("did:plc:a", NOW - 11 * MIN),
                { did: "did:plc:a", owedSinceUs: us(NOW - 12 * MIN), appliedAtMs: NOW - 5000 },
            ],
        })
        expect(got.lagging).toEqual(["did:plc:a"])
        expect(got.coveredThroughMs).toBe(NOW - 1000)
    })
})

describe("streamTimeUs", () => {
    it("is the cursor's microseconds, and 0 for anything that is not a time", () => {
        expect(streamTimeUs("1700000000000000")).toBe(1_700_000_000_000_000)
        for (const bad of ["", "abc", "-5", "0"]) expect(streamTimeUs(bad)).toBe(0)
    })
})

describe("gap signals (S6)", () => {
    const window = 36 * 60 * MIN

    it("isStaleCursor: a cursor older than the replay window", () => {
        expect(isStaleCursor(us(NOW - window - 1), NOW, window)).toBe(true)
    })

    it("isStaleCursor: not inside the window", () => {
        expect(isStaleCursor(us(NOW - window), NOW, window)).toBe(false)
        expect(isStaleCursor(us(NOW - 1000), NOW, window)).toBe(false)
    })

    it("isResumeJump: a first frame past the tolerance", () => {
        const cursor = us(NOW - 5 * MIN)
        expect(isResumeJump(cursor, cursor + us(2 * MIN + 1), 2 * MIN)).toBe(true)
        expect(isResumeJump(cursor, cursor + us(2 * MIN), 2 * MIN)).toBe(false)
        expect(isResumeJump(cursor, cursor - us(MIN), 2 * MIN)).toBe(false)
    })
})
