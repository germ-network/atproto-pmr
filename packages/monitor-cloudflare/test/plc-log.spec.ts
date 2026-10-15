/**
 * The ingest object keeps a log for every kept did:plc DID, extends it from
 * the stream, owes a fetch whenever the log may be missing operations, and
 * publishes it for the DID-document route.
 */
import { describe, it } from "vitest"

describe("MonitorIngest PLC logs", () => {
    it.todo("a DID joining the kept set is owed a log fetch")
    it.todo("a stream operation that chains is appended and republished")
    it.todo("a stream operation that does not chain, or with no log held, owes a fetch")
    it.todo("an operation for a DID whose document is not kept, or that is not watched, is ignored")
    it.todo("a coverage restart owes a fetch for every held log")
    it.todo("a stored log confirms the DID document it renders, as of its fetch")
    it.todo("putPlcLog for a DID that left the kept set stores nothing")
    it.todo("a DID leaving the kept set has its log and plclog: entry removed")
    it.todo("kvPlcLogs reads back what was published; a malformed entry reads null")
})
