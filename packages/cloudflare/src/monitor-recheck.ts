import type { MonitorRecheckRequest } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * `RecordReadDeps.requestRecheck` for a relay bound to a monitor: forwards
 * to the ingest object's `MonitorRecheckRequest.requestRefresh`. Never
 * throws, so a down monitor cannot fail a read's `waitUntil`; with no
 * monitor bound it does nothing.
 */
export function monitorRecheck(
    env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">,
    nowMs: () => number = Date.now
): (did: string) => Promise<void> {
    return async (did) => {
        const { MONITOR_INGEST, MONITOR_INGEST_NAME } = env
        if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) return
        try {
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorRecheckRequest
            await monitor.requestRefresh(did, nowMs())
        } catch (err) {
            console.warn(`monitorRecheck: refresh request failed for ${did}:`, err)
        }
    }
}
