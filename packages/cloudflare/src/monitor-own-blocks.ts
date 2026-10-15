import type { BlockEdgeStore } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * `SummaryPageDeps.blocks` for a relay bound to a monitor: forwards to the
 * ingest object's `MonitorOwnBlocksRequest.ownBlocks`. Unlike the re-check,
 * it throws when no monitor is bound or the call fails, so the summary
 * answers 503 rather than delivering an empty list that would clear every
 * device's blocks.
 */
export function monitorOwnBlocks(
    _env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">
): Pick<BlockEdgeStore, "ownBlocks"> {
    throw new Error("monitorOwnBlocks: not implemented")
}
