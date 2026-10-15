import type { PMREnv } from "./env"

/**
 * `RecordReadDeps.requestRecheck` for a relay bound to a monitor: forwards
 * to the ingest object's `MonitorRecheckRequest.requestRefresh`. Never
 * throws, so a down monitor cannot fail a read's `waitUntil`; with no
 * monitor bound it does nothing.
 */
export function monitorRecheck(
    _env: Pick<PMREnv, "MONITOR_INGEST" | "MONITOR_INGEST_NAME">,
    _nowMs: () => number = Date.now
): (did: string) => Promise<void> {
    return async () => {
        throw new Error("not implemented")
    }
}
