/**
 * Tier 3, baseline build: discover DIDs the live tail never will.
 *
 * The live tail (`ingest.ts`) only wakes on a *write* to the collection
 * after this monitor's connection opened. A DID that published its
 * declaration earlier and has not touched it since is invisible to tier 1
 * no matter how long the monitor runs — the digest's Bloom filter is
 * built over whatever the snapshot holds, and by design that is meant to
 * be every DID carrying the collection, not only the ones that happened
 * to write during this monitor's lifetime.
 *
 * This closes that gap by walking a relay's enumeration once, `owe`-ing a
 * fetch for anything not already indexed, and letting the existing
 * pending-fetch machinery (`settleDue`) do the actual fetch-verify-store —
 * this module only discovers obligations, it never fetches a record
 * itself.
 */

import type { ListReposPage } from "./list-repos"
import type { BackfillProgress, MonitorIndex } from "./storage"

export interface BackfillDeps {
    index: MonitorIndex
    listRepos(cursor: string | null): Promise<ListReposPage>
}

export interface SweepBackfillResult {
    /** DIDs newly owed by this call — not yet fetched, only enqueued. */
    discovered: number
    /** `true` once this call reached the end of the relay's enumeration. */
    done: boolean
}

/**
 * One page per call, so this fits the same per-tick budget as
 * `settleDue` rather than blocking an alarm on a full sweep. Safe to call
 * repeatedly after `done` — it is then a no-op, not a restart.
 */
export async function sweepBackfill(deps: BackfillDeps): Promise<SweepBackfillResult> {
    const progress = await deps.index.readBackfillProgress()
    if (progress.done) return { discovered: 0, done: true }

    const page = await deps.listRepos(progress.cursor)

    let discovered = 0
    for (const did of page.dids) {
        // Already indexed means already fetched, by construction — either
        // the live tail caught it, or an earlier sweep did. Re-owing it
        // here would cost a redundant PDS fetch for no new information.
        const indexed = await deps.index.revOf(did)
        if (indexed === null) {
            // The rev is unknown until the tier-2 fetch this obligation
            // triggers actually reads the PDS — `owe` only needs *a*
            // value for its bookkeeping column, never a real one, so an
            // empty placeholder here is not a compromise on the fetch
            // itself: `settle` gets the authoritative rev from the PDS
            // directly and never trusts what was recorded at intake.
            await deps.index.owe(did, "")
            discovered += 1
        }
    }

    const next: BackfillProgress =
        page.nextCursor === null ? { done: true } : { done: false, cursor: page.nextCursor }
    await deps.index.setBackfillProgress(next)

    return { discovered, done: next.done }
}
