/**
 * A did:plc operation log the PMR serves verifies the way a device verifies
 * it, and a stream operation that does not chain is never appended.
 */
import { describe, it } from "vitest"

describe("parsePlcAuditLog", () => {
    it.todo("parses a directory audit log body, oldest first, nullified entries kept")
    it.todo("is null for a body for another DID, or not an audit log")
})

describe("verifyPlcLog", () => {
    it.todo("a real directory audit log fixture verifies to the document the directory renders")
    it.todo("a log whose genesis is a legacy create verifies, hashed in its own format")
    it.todo("a legacy-only log renders the normalised document")
    it.todo("the operation after a legacy genesis is signed by recoveryKey or signingKey")
    it.todo("a genesis CID that does not name the DID throws")
    it.todo("an operation signed by a key that is not a prior rotation key throws")
    it.todo("an operation whose prev is not the prior operation's CID throws")
    it.todo("a CID that is not the operation's own throws")
    it.todo("nullified operations are skipped in the chain")
    it.todo("a nullified operation with no later live operation forking at or before it throws")
    it.todo("a tombstoned log verifies to null")
})

describe("appendPlcLogEntry", () => {
    it.todo("an operation whose prev is the last live CID is appended and moves asOfMs")
    it.todo("an operation that does not chain returns null")
    it.todo("a recovery operation forking before the tail returns null")
    it.todo("an entry whose cid is not its operation's own returns null")
})
