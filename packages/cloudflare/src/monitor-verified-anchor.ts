import type {
    MonitorVerifiedAnchorRequest,
    VerifiedAnchorObservation,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"
import { errorKind } from "./log-safe"

/**
 * The bound monitor's verified view of a DID's anchor, for deciding whether
 * to retire its registration. A down or unbound monitor answers `unknown`,
 * which retires nothing.
 */
export function monitorVerifiedAnchor(
    env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">
): (did: string) => Promise<VerifiedAnchorObservation> {
    return async (did) => {
        const { MONITOR_INGEST, MONITOR_INGEST_NAME } = env
        if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) {
            return { state: "unknown" }
        }
        try {
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorVerifiedAnchorRequest
            return await monitor.verifiedAnchorOf(did)
        } catch (err) {
            console.warn("monitorVerifiedAnchor: read failed", errorKind(err))
            return { state: "unknown" }
        }
    }
}
