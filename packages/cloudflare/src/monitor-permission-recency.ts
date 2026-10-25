import type { MonitorPermissionRecencyRequest } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * The public can-message route's optional ordering hint. A missing or
 * unavailable monitor must not block the policy verdict: unknown recency is
 * returned as null for every requested recipient.
 */
export function monitorPermissionRecencyReader(
    env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">
): (sender: string, recipients: readonly string[]) => Promise<Map<string, number | null>> {
    return async (sender, recipients) => {
        const unknown = () => new Map(recipients.map((did) => [did, null] as const))
        const { MONITOR_INGEST, MONITOR_INGEST_NAME } = env
        if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) return unknown()
        try {
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorPermissionRecencyRequest
            return await monitor.permissionRecencyForRecipients(sender, recipients)
        } catch {
            return unknown()
        }
    }
}
