/**
 * Computing the firehose coverage watermark from the stream cursor and the
 * fetches it still owes. The cursor advances when an event is owed, not when
 * it is applied, so the watermark is held back by the oldest owed event, and
 * by a fetch applied too recently for its KV write to be visible everywhere.
 * A DID whose owed event is older than the lag bound moves to the lagging list
 * instead, so one unreachable PDS cannot hold back everyone.
 */

import type { FirehoseCoverage } from "@germ-network/atproto-pmr-core"

/**
 * A held DID's oldest stream event that is still owed a fetch, or whose fetch
 * was applied within `KV_VISIBILITY_MS` (`appliedAtMs` set).
 */
export interface OwedStreamEvent {
    did: string
    /** 0 for a row owed before stamps existed: it lags at once. */
    owedSinceUs: number
    appliedAtMs: number | null
}

export interface FirehoseCoverageInput {
    /** The stream cursor, µs; null before the first event. */
    cursorUs: number | null
    /** Held DIDs only; never-held DIDs serve nothing and hold nothing back. */
    owed: readonly OwedStreamEvent[]
    /** Start of the current run; coverage is null until covered-through reaches it. */
    continuousSinceMs: number
    nowMs: number
    maxLagMs: number
    kvVisibilityMs: number
    laggingCap: number
}

export function computeFirehoseCoverage(input: FirehoseCoverageInput): FirehoseCoverage {
    const visible = (e: OwedStreamEvent) =>
        e.appliedAtMs === null || input.nowMs - e.appliedAtMs < input.kvVisibilityMs
    const lagging = new Set<string>()
    for (const e of input.owed) {
        if (visible(e) && input.nowMs - e.owedSinceUs / 1000 > input.maxLagMs) {
            lagging.add(e.did)
        }
    }
    const sorted = [...lagging].sort()
    const result = (coveredThroughMs: number | null): FirehoseCoverage => ({
        continuousSinceMs: input.continuousSinceMs,
        coveredThroughMs,
        lagging: sorted,
    })
    if (input.cursorUs === null || sorted.length > input.laggingCap) return result(null)

    let coveredThrough = Math.floor(input.cursorUs / 1000)
    for (const e of input.owed) {
        if (lagging.has(e.did)) continue
        if (!visible(e)) continue
        coveredThrough = Math.min(coveredThrough, Math.floor(e.owedSinceUs / 1000))
    }
    return result(coveredThrough < input.continuousSinceMs ? null : coveredThrough)
}

/** At connect: a cursor older than the stream's replay window cannot resume without a gap. */
export function isStaleCursor(cursorUs: number, nowMs: number, replayWindowMs: number): boolean {
    return nowMs - cursorUs / 1000 > replayWindowMs
}

/** After a resume: a first frame this far past the cursor means events were skipped. */
export function isResumeJump(cursorUs: number, firstFrameUs: number, toleranceMs: number): boolean {
    return (firstFrameUs - cursorUs) / 1000 > toleranceMs
}

/**
 * The stream time (µs) a cursor stands for. A cursor that is not a time
 * stamps as the oldest possible, so the event lags at once instead of
 * claiming coverage it cannot place. Exact below 2^53 µs.
 */
export function streamTimeUs(cursor: string): number {
    const us = Number(cursor)
    return Number.isFinite(us) && us > 0 ? us : 0
}
