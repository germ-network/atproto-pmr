import type { BlockEdgeStore, MonitorOwnBlocksRequest } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * `SummaryPageDeps.blocks` for a relay bound to a monitor: forwards to the
 * ingest object's `MonitorOwnBlocksRequest.ownBlocks`. Unlike the re-check,
 * it throws when no monitor is bound or the call fails, so the summary
 * answers 503 rather than delivering an empty list that would clear every
 * device's blocks.
 *
 * The relay half of `MonitorOwnBlocksRequest`, which describes the pattern.
 */
export function monitorOwnBlocks(
    env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">
): Pick<BlockEdgeStore, "ownBlocks"> {
    return {
        async ownBlocks(did) {
            const { MONITOR_INGEST, MONITOR_INGEST_NAME } = env
            if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) {
                throw new Error("no monitor is bound to read the owner's blocks from")
            }
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorOwnBlocksRequest
            return monitor.ownBlocks(did)
        },
    }
}
