/**
 * Verifies a single-record atproto repo proof — the CARv1 that
 * `com.atproto.sync.getRecord` returns and the monitor stores — against the
 * repo's signing key, and returns the record together with its CID.
 *
 * The CAR's provenance is irrelevant: a commit signed by the DID document's
 * `#atproto` key, an MST path from that commit to the record, and blocks
 * whose bytes hash to their CIDs prove the record wherever the bytes came
 * from. This is what lets the relay take a sender's declaration from a third
 * party instead of the sender's PDS.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { Token, Type, decode, encode } from "cborg"

export type RepoProofErrorCode =
    | "car-malformed"
    | "block-cid-mismatch"
    | "commit-malformed"
    | "did-mismatch"
    | "unsupported-key"
    | "signature-invalid"
    | "mst-malformed"
    | "record-absent"

export class RepoProofError extends Error {
    constructor(
        readonly code: RepoProofErrorCode,
        message: string
    ) {
        super(message)
        this.name = "RepoProofError"
    }
}

export interface RecordProofExpectation {
    did: string
    /** The DID document's `#atproto` `publicKeyMultibase` (secp256k1 or P-256 multikey). */
    signingKey: string
    collection: string
    rkey: string
}

export interface VerifiedRecord {
    /** CIDv1, dag-cbor, sha2-256, multibase base32-lower (`bafyrei…`). */
    cid: string
    /** The record block, decoded as DAG-CBOR (byte strings as `Uint8Array`). */
    record: unknown
    /** The signed commit's `rev`. */
    rev: string
}

/**
 * What a single-record proof shows under the signing key: the record, or that
 * the signed repo holds no record at that path, as of the signed rev.
 */
export type RecordProofOutcome =
    | ({ kind: "present" } & VerifiedRecord)
    | { kind: "absent"; rev: string }

/**
 * Like `verifyRecordProof`, but a valid absence is a result carrying the
 * signed rev rather than an error. Throws `RepoProofError` for anything that
 * does not verify.
 */
export function verifyRecordProofOutcome(
    car: Uint8Array,
    expected: RecordProofExpectation
): RecordProofOutcome {
    const parsed = parseProof(car, expected.did)
    verifyCommitSignature(parsed.commit, expected.signingKey)
    const found = findRecord(parsed, expected.collection, expected.rkey)
    if (!found) return { kind: "absent", rev: parsed.commit.rev }
    return { kind: "present", cid: found.cid, record: found.record, rev: parsed.commit.rev }
}

/**
 * Throws `RepoProofError`. `record-absent` means the proof is otherwise valid
 * and its signed view holds no record at that path.
 */
export function verifyRecordProof(
    car: Uint8Array,
    expect: RecordProofExpectation
): VerifiedRecord {
    const parsed = parseProof(car, expect.did)
    verifyCommitSignature(parsed.commit, expect.signingKey)
    const found = findRecord(parsed, expect.collection, expect.rkey)
    if (!found) throw new RepoProofError("record-absent", "no record at path")
    return { cid: found.cid, record: found.record, rev: parsed.commit.rev }
}

export interface CarRecord {
    cid: string
    record: unknown
    rev: string
    /** The commit's `did` field. */
    did: string
}

/**
 * The record at `<collection>/<rkey>` and its CID, from the CAR's own
 * commit, WITHOUT checking the commit signature: for change detection by a
 * party that already trusts where the bytes came from, never for admission.
 * The monitor verifies at ingest with `verifyRecordProofOutcome` and uses this
 * only to compare record CIDs of CARs it has already verified or holds. Block CIDs and the MST
 * path are still checked. `null` when the commit's tree holds no record at
 * that path.
 */
export function readRecordFromCar(
    car: Uint8Array,
    collection: string,
    rkey: string
): CarRecord | null {
    const parsed = parseProof(car, null)
    const found = findRecord(parsed, collection, rkey)
    if (!found) return null
    return {
        cid: found.cid,
        record: found.record,
        rev: parsed.commit.rev,
        did: parsed.commit.did,
    }
}

// ---------------------------------------------------------------------------

/** A DAG-CBOR CID link (tag 42): the CID's binary form, without the 0x00 prefix. */
export class CidLink {
    constructor(readonly bytes: Uint8Array) {}
}

export const CID_PREFIX = Uint8Array.of(0x01, 0x71, 0x12, 0x20)
export const CID_LENGTH = 36
export const MAX_MST_DEPTH = 128

// cborg's `strict` does not enforce map-key order or minimal floats; that is
// harmless here because every signed or hashed byte string is checked as given
// (block hashes) or re-encoded canonically (commit signature).
const DECODE_OPTIONS = {
    strict: true,
    rejectDuplicateMapKeys: true,
    allowIndefinite: false,
    allowUndefined: false,
    allowInfinity: false,
    allowNaN: false,
    allowBigInt: false,
    tags: (() => {
        const tags: Array<(decodeInner: () => unknown) => unknown> = []
        tags[42] = (decodeInner) => {
            const inner = decodeInner()
            if (
                !(inner instanceof Uint8Array) ||
                inner.length !== CID_LENGTH + 1 ||
                inner[0] !== 0
            ) {
                throw new Error("malformed CID link")
            }
            return new CidLink(inner.subarray(1))
        }
        return tags
    })(),
}

export function decodeCbor(bytes: Uint8Array): unknown {
    return decode(bytes, DECODE_OPTIONS)
}

/** Canonical DAG-CBOR re-encoding: length-first key order, CID links as tag 42. */
export function encodeDagCbor(value: unknown): Uint8Array {
    return encode(value, {
        typeEncoders: {
            Object: (obj: unknown) => {
                if (obj instanceof CidLink) {
                    const bytes = new Uint8Array(obj.bytes.length + 1)
                    bytes.set(obj.bytes, 1)
                    return [new Token(Type.tag, 42), new Token(Type.bytes, bytes)]
                }
                return null
            },
        },
    })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Uint8Array) &&
        !(value instanceof CidLink) &&
        !Array.isArray(value)
    )
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567"

export function cidToString(cid: Uint8Array): string {
    return `b${base32Lower(cid)}`
}

/** RFC 4648 base32, lower case, unpadded. */
export function base32Lower(bytes: Uint8Array): string {
    let out = ""
    let acc = 0
    let bits = 0
    for (const byte of bytes) {
        acc = (acc << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += B32[(acc >>> (bits - 5)) & 31]
            bits -= 5
        }
        acc &= (1 << bits) - 1
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
    return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
    return a.length - b.length
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
    let value = 0
    let shift = 0
    for (let i = offset; i < bytes.length && i < offset + 8; i++) {
        const byte = bytes[i]!
        value += (byte & 0x7f) * 2 ** shift
        if ((byte & 0x80) === 0) return [value, i + 1]
        shift += 7
    }
    throw new RepoProofError("car-malformed", "truncated varint")
}

export interface Commit {
    did: string
    version: number
    data: CidLink
    rev: string
    prev: CidLink | null
    sig: Uint8Array
}

interface ParsedProof {
    blocks: Map<string, Uint8Array>
    commit: Commit
}

function parseProof(car: Uint8Array, expectedDID: string | null): ParsedProof {
    let offset = 0
    const [headerLength, afterHeaderLength] = readVarint(car, offset)
    offset = afterHeaderLength
    if (headerLength === 0 || offset + headerLength > car.length) {
        throw new RepoProofError("car-malformed", "truncated header")
    }
    let header: unknown
    try {
        header = decodeCbor(car.subarray(offset, offset + headerLength))
    } catch {
        throw new RepoProofError("car-malformed", "undecodable header")
    }
    offset += headerLength
    if (
        !isRecord(header) ||
        header.version !== 1 ||
        !Array.isArray(header.roots) ||
        header.roots.length < 1 ||
        !(header.roots[0] instanceof CidLink)
    ) {
        throw new RepoProofError("car-malformed", "not a CARv1 with a root")
    }
    const root = header.roots[0]

    const blocks = new Map<string, Uint8Array>()
    while (offset < car.length) {
        const [sectionLength, start] = readVarint(car, offset)
        const end = start + sectionLength
        if (sectionLength < CID_LENGTH || end > car.length) {
            throw new RepoProofError("car-malformed", "truncated section")
        }
        const cid = car.subarray(start, start + CID_LENGTH)
        const data = car.subarray(start + CID_LENGTH, end)
        if (!bytesEqual(cid.subarray(0, 4), CID_PREFIX)) {
            throw new RepoProofError(
                "car-malformed",
                "only CIDv1 dag-cbor sha2-256 blocks are accepted"
            )
        }
        if (!bytesEqual(sha256(data), cid.subarray(4))) {
            throw new RepoProofError(
                "block-cid-mismatch",
                "block bytes do not hash to their CID"
            )
        }
        blocks.set(cidToString(cid), data)
        offset = end
    }

    const commitBytes = blocks.get(cidToString(root.bytes))
    if (!commitBytes) {
        throw new RepoProofError("commit-malformed", "root block missing")
    }
    const commit = parseCommit(commitBytes)
    if (expectedDID !== null && commit.did !== expectedDID) {
        throw new RepoProofError("did-mismatch", "commit is for a different DID")
    }
    return { blocks, commit }
}

export function parseCommit(bytes: Uint8Array): Commit {
    let value: unknown
    try {
        value = decodeCbor(bytes)
    } catch {
        throw new RepoProofError("commit-malformed", "undecodable commit")
    }
    if (
        !isRecord(value) ||
        typeof value.did !== "string" ||
        value.version !== 3 ||
        !(value.data instanceof CidLink) ||
        typeof value.rev !== "string" ||
        !(value.prev === null || value.prev instanceof CidLink) ||
        !(value.sig instanceof Uint8Array)
    ) {
        throw new RepoProofError("commit-malformed", "not a v3 repo commit")
    }
    return {
        did: value.did,
        version: 3,
        data: value.data,
        rev: value.rev,
        prev: value.prev,
        sig: value.sig,
    }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58Decode(text: string): Uint8Array | null {
    const out: number[] = []
    for (const ch of text) {
        let carry = BASE58.indexOf(ch)
        if (carry < 0) return null
        for (let i = 0; i < out.length; i++) {
            carry += out[i]! * 58
            out[i] = carry & 0xff
            carry >>= 8
        }
        while (carry > 0) {
            out.push(carry & 0xff)
            carry >>= 8
        }
    }
    for (const ch of text) {
        if (ch !== "1") break
        out.push(0)
    }
    return Uint8Array.from(out.reverse())
}

/**
 * Whether `sig` (64 bytes, r then s) is a canonical low-S ECDSA-SHA256
 * signature of `message` under a compressed secp256k1 or P-256 multikey
 * (`z…`). False for any other key, rather than a throw.
 */
export function verifyMultikeySignature(
    multikey: string,
    message: Uint8Array,
    sig: Uint8Array
): boolean {
    const decoded = multikey.startsWith("z") ? base58Decode(multikey.slice(1)) : null
    if (!decoded || decoded.length !== 35) return false
    const publicKey = decoded.subarray(2)
    let curve: typeof secp256k1 | typeof p256
    if (decoded[0] === 0xe7 && decoded[1] === 0x01) curve = secp256k1
    else if (decoded[0] === 0x80 && decoded[1] === 0x24) curve = p256
    else return false
    try {
        return curve.verify(sig, message, publicKey, { lowS: true, prehash: true })
    } catch {
        return false
    }
}

export function verifyCommitSignature(commit: Commit, signingKey: string): void {
    const decoded = signingKey.startsWith("z")
        ? base58Decode(signingKey.slice(1))
        : null
    if (!decoded || decoded.length !== 35) {
        throw new RepoProofError("unsupported-key", "not a compressed multikey")
    }
    const publicKey = decoded.subarray(2)
    let curve: typeof secp256k1 | typeof p256
    if (decoded[0] === 0xe7 && decoded[1] === 0x01) curve = secp256k1
    else if (decoded[0] === 0x80 && decoded[1] === 0x24) curve = p256
    else throw new RepoProofError("unsupported-key", "unsupported key type")

    const unsigned = encodeDagCbor({
        did: commit.did,
        version: commit.version,
        data: commit.data,
        rev: commit.rev,
        prev: commit.prev,
    })
    let ok = false
    try {
        ok = curve.verify(commit.sig, unsigned, publicKey, {
            lowS: true,
            prehash: true,
        })
    } catch {
        ok = false
    }
    if (!ok) {
        throw new RepoProofError("signature-invalid", "commit signature invalid")
    }
}

export interface MstEntry {
    key: Uint8Array
    value: CidLink
    right: CidLink | null
}

export interface MstNode {
    left: CidLink | null
    entries: MstEntry[]
}

export function decodeNode(bytes: Uint8Array): MstNode {
    let value: unknown
    try {
        value = decodeCbor(bytes)
    } catch {
        throw new RepoProofError("mst-malformed", "undecodable node")
    }
    if (
        !isRecord(value) ||
        !Array.isArray(value.e) ||
        !(value.l === null || value.l instanceof CidLink)
    ) {
        throw new RepoProofError("mst-malformed", "not an MST node")
    }
    const entries: MstEntry[] = []
    let previous: Uint8Array = new Uint8Array(0)
    for (const raw of value.e) {
        if (
            !isRecord(raw) ||
            typeof raw.p !== "number" ||
            !Number.isInteger(raw.p) ||
            raw.p < 0 ||
            raw.p > previous.length ||
            !(raw.k instanceof Uint8Array) ||
            !(raw.v instanceof CidLink) ||
            !(raw.t === null || raw.t instanceof CidLink)
        ) {
            throw new RepoProofError("mst-malformed", "malformed MST entry")
        }
        const key = new Uint8Array(raw.p + raw.k.length)
        key.set(previous.subarray(0, raw.p))
        key.set(raw.k, raw.p)
        entries.push({ key, value: raw.v, right: raw.t })
        previous = key
    }
    return { left: value.l, entries }
}

// MST ordering and layer invariants are not re-checked: every block is reachable
// from the signed commit through a hash chain, so a walk can only land on what
// the signer committed to.
function findRecord(
    proof: ParsedProof,
    collection: string,
    rkey: string
): { cid: string; record: unknown } | null {
    const target = new TextEncoder().encode(`${collection}/${rkey}`)
    let link: CidLink | null = proof.commit.data
    for (let depth = 0; link !== null; depth++) {
        if (depth > MAX_MST_DEPTH) {
            throw new RepoProofError("mst-malformed", "tree too deep")
        }
        const nodeBytes = proof.blocks.get(cidToString(link.bytes))
        if (!nodeBytes) {
            throw new RepoProofError("mst-malformed", "MST node missing from CAR")
        }
        const node = decodeNode(nodeBytes)
        let next: CidLink | null = null
        let descended = false
        let previousRight = node.left
        for (const entry of node.entries) {
            const order = compareBytes(target, entry.key)
            if (order === 0) {
                const cid = cidToString(entry.value.bytes)
                const block = proof.blocks.get(cid)
                if (!block) {
                    throw new RepoProofError(
                        "mst-malformed",
                        "record block missing from CAR"
                    )
                }
                let record: unknown
                try {
                    record = decodeCbor(block)
                } catch {
                    throw new RepoProofError("mst-malformed", "undecodable record")
                }
                return { cid, record }
            }
            if (order < 0) {
                next = previousRight
                descended = true
                break
            }
            previousRight = entry.right
        }
        if (!descended) next = previousRight
        link = next
    }
    return null
}
