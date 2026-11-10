import type { FollowEdgeWriter } from "@germ-network/atproto-pmr-monitor"

/**
 * What one committed write changed, as far as owner summaries go.
 *
 * `dids` changed their own standing (a declaration settled or went, a DID
 * started or stopped being an owner, holder or interest member), so every
 * owner whose summary covers them is affected: their followers, the accounts
 * they follow, and themselves. `owners` are affected directly and are not
 * expanded: an edge's effect on a summary stops at its two endpoints.
 */
export interface SummaryInputsChange {
    dids: readonly string[]
    owners: readonly string[]
}

/**
 * The graph owners whose summary `change` may have altered: followers of
 * `dids`, the subjects `dids` follow, `dids` themselves and `owners`,
 * restricted to `graph_owners`. One indexed statement per chunk of DIDs,
 * sorted and without duplicates.
 */
export async function summaryOwnersAffected(
    db: D1Database,
    change: SummaryInputsChange
): Promise<string[]> {
    throw new Error("unimplemented")
}

/**
 * `writer`, reporting each committed write's summary inputs to `report`
 * after its batch resolves. A write that changed nothing reports nothing,
 * and a `report` that throws is logged, never surfaced to the caller: the
 * write already committed, and the step that made it still has bookkeeping
 * to finish.
 */
export function summaryInputTracking(
    writer: FollowEdgeWriter,
    report: (change: SummaryInputsChange) => Promise<void>
): FollowEdgeWriter {
    throw new Error("unimplemented")
}
