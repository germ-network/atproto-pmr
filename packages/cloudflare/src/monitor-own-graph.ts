import type { MonitorOwnGraphRequest } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * `SummaryPageDeps.graph` for a relay bound to a monitor: forwards to the
 * ingest object's `MonitorOwnGraphRequest.ownGraph`, and throws when no
 * monitor is bound or the call fails, as `monitorOwnBlocks` does, so the
 * summary answers 503 rather than choosing contacts from an empty graph.
 */
export function monitorOwnGraph(
    env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">
): MonitorOwnGraphRequest {
    return {
        async ownGraph(did) {
            const { MONITOR_INGEST, MONITOR_INGEST_NAME } = env
            if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) {
                throw new Error("no monitor is bound to read the owner's graph from")
            }
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorOwnGraphRequest
            return monitor.ownGraph(did)
        },
    }
}
