/**
 * Keeps each watched did:plc DID's signed operation log, so the relay can
 * serve one a device verifies itself. The export stream extends a log; the
 * directory's audit log starts or repairs one.
 */
import {
    parsePlcAuditLog,
    verifyPlcLog,
    type PlcLog,
    type PlcLogEntry,
} from "@germ-network/atproto-pmr-core"

export interface PlcLogIndex {
    /**
     * A stream operation for `did`. Appended when it chains onto the held
     * log; otherwise, or with no log held, the DID is owed a fetch. Ignored
     * for a DID whose document is not kept. Index I/O only.
     */
    intakePlcLogEntry(did: string, entry: PlcLogEntry): Promise<void>
    /** Owe a fetch: on joining the kept set, and for every held log when stream coverage restarts. */
    owePlcLog(did: string, owedAtMs: number): Promise<void>
    /** Owed DIDs not attempted since `attemptedBeforeMs`, oldest debt first. */
    owedPlcLogs(attemptedBeforeMs: number, limit: number): Promise<string[]>
    /** Store a fetched, verified log and clear the debt, unless the DID left the kept set. */
    putPlcLog(log: PlcLog): Promise<void>
    /** A fetch that did not yield a verified log: retried after the interval, not before. */
    markPlcLogAttempted(did: string, attemptedAtMs: number): Promise<void>
}

export interface DrainPlcLogsDeps {
    index: PlcLogIndex
    /** The directory's `/<did>/log/audit` body; a throw is a failed attempt. */
    fetchAuditLog(did: string): Promise<unknown>
    nowMs(): number
}

/** How long a failed log fetch waits before its retry. */
export const PLC_LOG_RETRY_MS = 60 * 60 * 1000

/**
 * Fetches up to `limit` owed logs, storing each that parses and verifies
 * (`verifyPlcLog`) with `asOfMs` at the fetch; any other outcome is a
 * failed attempt. Returns how many were stored.
 */
export async function drainPlcLogs(deps: DrainPlcLogsDeps, limit: number): Promise<number> {
    const owed = await deps.index.owedPlcLogs(deps.nowMs() - PLC_LOG_RETRY_MS, limit)
    let stored = 0
    for (const did of owed) {
        const fetchedAtMs = deps.nowMs()
        try {
            const entries = parsePlcAuditLog(did, await deps.fetchAuditLog(did))
            if (entries === null) throw new Error("not an audit log for the DID")
            verifyPlcLog(did, entries)
            await deps.index.putPlcLog({ did, entries, asOfMs: fetchedAtMs })
            stored += 1
        } catch (error) {
            console.warn(`plc log: fetch for ${did} failed`, error)
            await deps.index.markPlcLogAttempted(did, fetchedAtMs)
        }
    }
    return stored
}
