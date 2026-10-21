/**
 * The firehose coverage watermark (`spec/key-transparency.md`, "The coverage
 * watermarks") and what the owner summary carries of it (`spec/wire-api.md`,
 * the summary's `w` and `l`).
 */

import type { PlcCoverage } from "./did-document.js"

/** How far behind real time the firehose watermark may be and still count as current. */
export const FIREHOSE_COVERAGE_MAX_LAG_MS = 10 * 60 * 1000

/** Most DIDs the lagging list holds; past it the monitor publishes no coverage. */
export const FIREHOSE_LAGGING_CAP = 1000

/** How long a KV write may take to be visible everywhere; a fetch counts as applied only after it. */
export const KV_VISIBILITY_MS = 60 * 1000

/**
 * Every declaration commit and identity or account event the firehose
 * sequenced from `continuousSinceMs` through `coveredThroughMs` has been
 * applied, except for the DIDs on `lagging`. Published as one KV value so a
 * reader never pairs one tick's watermark with another tick's list.
 */
export interface FirehoseCoverage {
    /** Start of the current unbroken run; a stream gap resets it. */
    continuousSinceMs: number
    /** Null: no coverage (resyncing, before a cursor, or over the lagging cap). */
    coveredThroughMs: number | null
    /** Held DIDs owed an event older than the lag bound; sorted. */
    lagging: readonly string[]
}

/**
 * The summary's `w`: the earlier of the two covered-through instants, or null
 * when either is missing — a missing watermark is no coverage.
 */
export function summaryCoverageAtMs(
    _firehose: FirehoseCoverage | null,
    _plc: PlcCoverage | null
): number | null {
    throw new Error("unimplemented")
}

/** Merged into `SummaryPageDeps` in S7. */
export interface SummaryCoverageDeps {
    /** Read before the index and any CAR, so nothing served is older than `w`. */
    getFirehoseCoverage(): Promise<FirehoseCoverage | null>
    getPlcCoverage(): Promise<PlcCoverage | null>
}
