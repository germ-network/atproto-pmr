/**
 * The monitor's kept did:plc logs are fetched whole from the directory,
 * stored only once they verify, and retried at a bounded rate.
 */
import { describe, it } from "vitest"

describe("drainPlcLogs", () => {
    it.todo("stores a fetched log that verifies, asOfMs at the fetch")
    it.todo("a log that does not parse or verify is a failed attempt, not stored")
    it.todo("a fetch that throws is a failed attempt")
    it.todo("drains at most limit owed DIDs, skipping those attempted within PLC_LOG_RETRY_MS")
})
