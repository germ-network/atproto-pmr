/**
 * A did:plc DID's signed operation log, as the directory's audit log serves
 * it: the chain a device verifies from the genesis operation (whose CID
 * names the DID) through each operation signed by a rotation key of the one
 * before it, so it can trust the DID document without trusting the PMR.
 */

import type { DidDocument } from "./did-document"

export interface PlcLogEntry {
    /** The operation's CID, as the directory reports it. */
    cid: string
    /**
     * The signed operation exactly as the directory serves it, `sig`
     * included; a verifier re-encodes it as DAG-CBOR.
     */
    operation: Record<string, unknown>
    createdAtMs: number
    /**
     * The directory nullified it (a fork recovered by a higher-priority
     * rotation key). Like `createdAtMs`, a directory annotation, not signed
     * data: a device trusts it as it trusts the log's completeness. The
     * export stream does not carry it, so a stream entry is never nullified.
     */
    nullified: boolean
}

export interface PlcLog {
    did: string
    /** Oldest first, nullified entries included. */
    entries: PlcLogEntry[]
    /**
     * When this log was last known whole: its audit-log fetch, or the
     * latest stream operation that chained onto it.
     */
    asOfMs: number
}

/**
 * The entries of a `GET <directory>/<did>/log/audit` body, oldest first.
 * Null when the body is not an audit log for `did`.
 */
export function parsePlcAuditLog(_did: string, _body: unknown): PlcLogEntry[] | null {
    throw new Error("not implemented")
}

/**
 * `log` with a stream operation appended, or null when it does not chain
 * (its `prev` is not the last non-nullified entry's CID, as for a recovery
 * operation that forks) or its `cid` is not the operation's own: the log
 * may be missing operations and must be re-fetched.
 */
export function appendPlcLogEntry(_log: PlcLog, _entry: PlcLogEntry): PlcLog | null {
    throw new Error("not implemented")
}

/**
 * Verifies the chain as a device would: the genesis CID names `did`, each
 * non-nullified operation's `prev` is the CID of the one before it and its
 * signature verifies under a rotation key of that one, every CID is the
 * operation's own, and every nullified operation is superseded by a later
 * live one whose `prev` is at or before its own (the fork point). A legacy
 * `create` genesis is hashed and verified in its own format, and normalised
 * for the chain (rotation keys `[recoveryKey, signingKey]`) and for
 * rendering. Returns the document the last live operation renders, or null
 * for a tombstoned DID; throws on any break.
 */
export function verifyPlcLog(_did: string, _entries: readonly PlcLogEntry[]): DidDocument | null {
    throw new Error("not implemented")
}
