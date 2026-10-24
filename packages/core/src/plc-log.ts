/**
 * A did:plc DID's signed operation log, as the directory's audit log serves
 * it: the chain a device verifies from the genesis operation (whose CID
 * names the DID) through each operation signed by a rotation key of the one
 * before it, so it can trust the DID document without trusting the PMR.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { renderPlcDocument, type DidDocument } from "./did-document"
import {
    CID_PREFIX,
    base32Lower,
    cidToString,
    encodeDagCbor,
    verifyMultikeySignature,
} from "./repo-proof"
import { base64URLToBinary, binaryToBase64URL } from "./util"

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
export function parsePlcAuditLog(did: string, body: unknown): PlcLogEntry[] | null {
    if (!Array.isArray(body) || body.length === 0) return null
    const entries: PlcLogEntry[] = []
    for (const item of body) {
        if (!isRecord(item) || item.did !== did) return null
        if (typeof item.cid !== "string" || !isRecord(item.operation)) return null
        if (typeof item.nullified !== "boolean" || typeof item.createdAt !== "string") return null
        const createdAtMs = Date.parse(item.createdAt)
        if (!Number.isFinite(createdAtMs)) return null
        entries.push({
            cid: item.cid,
            operation: item.operation,
            createdAtMs,
            nullified: item.nullified,
        })
    }
    return entries
}

/**
 * `log` with a stream operation appended, or null when it does not chain
 * (its `prev` is not the last non-nullified entry's CID, as for a recovery
 * operation that forks), its `cid` is not the operation's own, or it is not
 * signed by a rotation key of that last entry: the log may be missing
 * operations and must be re-fetched.
 */
export function appendPlcLogEntry(log: PlcLog, entry: PlcLogEntry): PlcLog | null {
    const last = [...log.entries].reverse().find((e) => !e.nullified)
    if (!last || last.operation.type === "plc_tombstone") return null
    if (entry.operation.prev !== last.cid) return null
    if (entry.nullified || operationCid(entry.operation) !== entry.cid) return null
    if (entry.operation.type === "create") return null
    try {
        verifySignedBy(entry, rotationKeysOf(last.operation))
    } catch {
        return null
    }
    return {
        ...log,
        entries: [...log.entries, entry],
        asOfMs: Math.max(log.asOfMs, entry.createdAtMs),
    }
}

/**
 * Verifies the chain as a device would: the genesis CID names `did`, each
 * non-nullified operation's `prev` is the CID of the one before it and its
 * signature verifies under a rotation key of that one, every CID is the
 * operation's own, and every nullified operation is superseded by a later
 * live one whose `prev` is at or before its own (the fork point). A legacy
 * `create` genesis is hashed and verified in its own format, and normalised
 * for the chain (its `recoveryKey` and `signingKey` are its rotation keys) and
 * for rendering. Nullified operations are checked for their CID and signature
 * too. Returns the document the last live operation renders, or null
 * for a tombstoned DID; throws on any break.
 *
 * Follows the did:plc specification v0.3.0 (December 2025), "Audit Logs": for
 * the genesis, "validate the DID" from its hash; for each operation, take
 * "the keys in the prev operation" and accept the signature if any "of the
 * rotationKeys" verifies over the DAG-CBOR of the operation without `sig`;
 * "if no key matches, there has been a trust violation". Signatures must be
 * low-S and canonically base64url-encoded ("Operation Serialization,
 * Signing, and Validation").
 *
 * The recovery window and the priority of the rotation keys are not
 * re-checked: whether a fork was a valid recovery is the directory's
 * judgement, which a device trusts as it trusts the log's completeness.
 */
export function verifyPlcLog(did: string, entries: readonly PlcLogEntry[]): DidDocument | null {
    if (entries.length === 0) throw new PlcLogError("empty log")
    const index = new Map<string, number>()
    entries.forEach((entry, i) => {
        if (operationCid(entry.operation) !== entry.cid) {
            throw new PlcLogError(`entry ${i}: cid is not the operation's own`)
        }
        if (index.has(entry.cid)) throw new PlcLogError(`entry ${i}: duplicate cid`)
        index.set(entry.cid, i)
    })

    const genesis = entries[0]!
    if (genesis.nullified) throw new PlcLogError("the genesis operation is nullified")
    if (genesis.operation.prev !== null) throw new PlcLogError("genesis has a prev")
    if (didOfGenesis(genesis.operation) !== did) {
        throw new PlcLogError("genesis does not name the DID")
    }

    let live: PlcLogEntry | null = null
    for (const [i, entry] of entries.entries()) {
        if (entry.nullified) {
            // Skipped in the chain, but still a signed operation of the log.
            const prior = entries[positionOfPrev(entry, index, i)]!
            verifySignedBy(entry, rotationKeysOf(prior.operation))
            continue
        }
        if (live === null) {
            verifySignedBy(entry, rotationKeysOf(entry.operation))
        } else {
            if (live.operation.type === "plc_tombstone") {
                throw new PlcLogError(`entry ${i}: operation after a tombstone`)
            }
            if (entry.operation.prev !== live.cid) {
                throw new PlcLogError(`entry ${i}: prev is not the preceding live operation`)
            }
            if (entry.operation.type === "create") {
                throw new PlcLogError(`entry ${i}: legacy create after the genesis`)
            }
            verifySignedBy(entry, rotationKeysOf(live.operation))
        }
        live = entry
    }

    entries.forEach((entry, i) => {
        if (!entry.nullified) return
        const forkAt = positionOfPrev(entry, index, i)
        const superseded = entries.some(
            (later, j) =>
                j > i && !later.nullified && positionOfPrev(later, index, j) <= forkAt
        )
        if (!superseded) {
            throw new PlcLogError(`entry ${i}: nullified with no later operation forking at or before it`)
        }
    })

    const last = live!
    if (last.operation.type === "plc_tombstone") return null
    const rendered = renderPlcDocument(did, normalisedOperation(last.operation))
    if (!rendered) {
        throw new PlcLogError("the last operation does not render a DID document", "unrenderable")
    }
    return rendered
}

/**
 * Verify only the latest live operation of `did`'s log and that it
 * authorizes `signingKey`: a genesis by its CID naming `did` and its own
 * rotation keys, any later operation by its link to the immediately
 * preceding one and that one's rotation keys. This deliberately omits the
 * genesis-to-head custody proof and is suitable only for the labelled
 * current-key cross-check assurance mode.
 */
export function verifyPlcCurrentKeyOperation(
    did: string,
    entries: readonly PlcLogEntry[],
    signingKey: string
): string | null {
    let currentIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i]!.nullified) { currentIndex = i; break }
    }
    if (currentIndex < 0) return null
    const current = entries[currentIndex]!
    if (operationCid(current.operation) !== current.cid) return null
    let signers: string[]
    if (currentIndex === 0) {
        if (current.operation.prev !== null || didOfGenesis(current.operation) !== did) return null
        signers = rotationKeysOf(current.operation)
    } else {
        let priorIndex = currentIndex - 1
        while (priorIndex >= 0 && entries[priorIndex]!.nullified) priorIndex--
        if (priorIndex < 0) return null
        const prior = entries[priorIndex]!
        if (current.operation.type !== "plc_operation" ||
            current.operation.prev !== prior.cid ||
            operationCid(prior.operation) !== prior.cid) return null
        signers = rotationKeysOf(prior.operation)
    }
    const methods = normalisedOperation(current.operation).verificationMethods
    const atproto = isRecord(methods) ? methods.atproto : null
    if (atproto !== `${DID_KEY_PREFIX}${signingKey}`) return null
    try {
        verifySignedBy(current, signers)
        return current.cid
    } catch {
        return null
    }
}

/**
 * `broken`: the log is not a valid chain (a trust violation). `unrenderable`:
 * it verifies, but its last operation is a state this module does not render
 * as a DID document, which says nothing against the log.
 */
export class PlcLogError extends Error {
    constructor(
        message: string,
        readonly kind: "broken" | "unrenderable" = "broken"
    ) {
        super(`did:plc log: ${message}`)
        this.name = "PlcLogError"
    }
}

/** The CID the directory reports for an operation: CIDv1, dag-cbor, sha2-256, over the signed operation. */
function operationCid(operation: Record<string, unknown>): string {
    return cidToString(Uint8Array.of(...CID_PREFIX, ...sha256(encodeDagCbor(operation))))
}

/** The genesis names the DID: the first 24 characters of the base32 of its SHA-256. */
function didOfGenesis(operation: Record<string, unknown>): string {
    return `did:plc:${base32Lower(sha256(encodeDagCbor(operation))).slice(0, 24)}`
}

function positionOfPrev(entry: PlcLogEntry, index: Map<string, number>, own: number): number {
    const prev = entry.operation.prev
    const position = typeof prev === "string" ? index.get(prev) : undefined
    if (position === undefined || position >= own) {
        throw new PlcLogError(`entry ${own}: prev is not an earlier operation`)
    }
    return position
}

function verifySignedBy(entry: PlcLogEntry, keys: string[]): void {
    const { sig, ...unsigned } = entry.operation
    if (typeof sig !== "string") throw new PlcLogError("operation has no signature")
    let bytes: Uint8Array
    try {
        bytes = base64URLToBinary(sig)
    } catch {
        throw new PlcLogError("signature is not base64url")
    }
    // Strict encoding: unpadded, zero trailing bits, 64 bytes.
    if (bytes.length !== 64 || binaryToBase64URL(bytes) !== sig) {
        throw new PlcLogError("signature is not canonically encoded")
    }
    const message = encodeDagCbor(unsigned)
    const ok = keys.some(
        (key) =>
            key.startsWith(DID_KEY_PREFIX) &&
            verifyMultikeySignature(key.slice(DID_KEY_PREFIX.length), message, bytes)
    )
    if (!ok) throw new PlcLogError("signature does not verify under a rotation key of the prior operation")
}

const DID_KEY_PREFIX = "did:key:"

/**
 * The keys that may sign the operation after `operation`. A legacy `create`
 * has no rotation keys of its own; its `recoveryKey` and `signingKey` are
 * accepted, as the reference implementation normalises it. The did:plc
 * specification does not define that conversion, so the set is a documented
 * choice, and only its membership (not its order) matters here. A genesis is
 * verified under its own keys.
 */
function rotationKeysOf(operation: Record<string, unknown>): string[] {
    if (operation.type === "create") {
        return [operation.recoveryKey, operation.signingKey].filter(
            (key): key is string => typeof key === "string"
        )
    }
    if (operation.type === "plc_operation" && Array.isArray(operation.rotationKeys)) {
        return operation.rotationKeys.filter((key): key is string => typeof key === "string")
    }
    return []
}

/** A legacy `create` as the regular operation it stands for; any other operation as is. */
function normalisedOperation(operation: Record<string, unknown>): Record<string, unknown> {
    if (operation.type !== "create") return operation
    return {
        type: "plc_operation",
        rotationKeys: [operation.recoveryKey, operation.signingKey],
        verificationMethods: { atproto: operation.signingKey },
        alsoKnownAs: [`at://${String(operation.handle)}`],
        services: {
            atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: operation.service },
        },
        prev: null,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
