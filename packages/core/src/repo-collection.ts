/**
 * Reads every record of one collection out of a whole-repo CAR
 * (`com.atproto.sync.getRepo`), proved under the repo's signing key: a
 * commit signed by the DID document's `#atproto` key, an MST walk over the
 * collection's whole key range, and hash-checked blocks for everything the
 * walk reads.
 *
 * The CAR is consumed as a stream and only what the walk can need is kept —
 * the commit, MST nodes, and record blocks that may belong to the collection
 * — so a large repo of mostly unrelated records does not have to fit in
 * memory. Dropping a block the walk never reads does not weaken the proof:
 * the tree commits to every record by CID.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import {
    CID_LENGTH,
    CID_PREFIX,
    CidLink,
    MAX_MST_DEPTH,
    RepoProofError,
    bytesEqual,
    cidToString,
    compareBytes,
    decodeCbor,
    decodeNode,
    isRecord,
    parseCommit,
    verifyCommitSignature,
    type Commit,
    type RepoProofErrorCode,
} from "./repo-proof"

export type RepoCollectionErrorCode =
    | RepoProofErrorCode
    /** A key in the collection's range whose record block the CAR omits. */
    | "block-missing"
    | "byte-cap-exceeded"
    | "node-cap-exceeded"

export class RepoCollectionError extends Error {
    constructor(
        readonly code: RepoCollectionErrorCode,
        message: string
    ) {
        super(message)
        this.name = "RepoCollectionError"
    }
}

export interface RepoCollectionExpectation {
    did: string
    /** The DID document's `#atproto` `publicKeyMultibase` (secp256k1 or P-256 multikey). */
    signingKey: string
    collection: string
    /**
     * Refuse once this many CAR bytes have been read. Retained bytes are
     * bounded by it too, so size it below the caller's memory headroom.
     */
    maxBytes: number
    /** Refuse once this many MST nodes are held. */
    maxNodes: number
}

export interface CollectionRecord {
    rkey: string
    /** CIDv1, dag-cbor, sha2-256, multibase base32-lower (`bafyrei…`). */
    cid: string
    /** The record block, decoded as DAG-CBOR (byte strings as `Uint8Array`). */
    record: unknown
}

export interface VerifiedCollection {
    /** The signed commit's `rev`. */
    rev: string
    records: CollectionRecord[]
}

export const DEFAULT_MAX_REPO_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_MST_NODES = 200_000

const MAX_HEADER_BYTES = 64 * 1024
const MAX_BLOCK_BYTES = 2 * 1024 * 1024

/**
 * Throws `RepoCollectionError`. An empty collection is not an error: it
 * returns no records at the signed rev.
 */
export async function verifyRepoCollection(
    car: AsyncIterable<Uint8Array>,
    expected: RepoCollectionExpectation
): Promise<VerifiedCollection> {
    try {
        const kept = await readKeptBlocks(car, expected)
        return walkCollection(kept, expected)
    } catch (error) {
        if (error instanceof RepoProofError) {
            throw new RepoCollectionError(error.code, error.message)
        }
        throw error
    }
}

interface KeptBlocks {
    root: string
    blocks: Map<string, Uint8Array>
}

/**
 * Reads the CAR section by section, keeping (as copies, so no input chunk is
 * pinned) only the root commit, MST nodes, and blocks that could be a record
 * of the collection. Kept blocks are hash-checked; the rest are never read
 * again, since the signed tree reaches every record by CID.
 */
async function readKeptBlocks(
    car: AsyncIterable<Uint8Array>,
    expected: RepoCollectionExpectation
): Promise<KeptBlocks> {
    let pending = new Uint8Array(0)
    const incoming: Uint8Array[] = []
    let incomingLength = 0
    // Bytes `pending` must reach before the next section can parse, so a
    // slow stream's chunks are joined once per section, not once per chunk.
    let needed = 1
    let total = 0
    let root: Uint8Array | null = null
    let nodes = 0
    const blocks = new Map<string, Uint8Array>()

    const consume = (): void => {
        let offset = 0
        for (;;) {
            const length = tryReadVarint(pending, offset)
            if (length === null) {
                needed = pending.length - offset + 1
                break
            }
            const [size, start] = length
            const limit = root === null ? MAX_HEADER_BYTES : MAX_BLOCK_BYTES + CID_LENGTH
            if (size > limit) {
                throw new RepoProofError("car-malformed", "section too large")
            }
            if (start + size > pending.length) {
                needed = start + size - offset
                break
            }
            const section = pending.subarray(start, start + size)
            offset = start + size
            if (root === null) {
                root = parseHeaderRoot(section)
                continue
            }
            if (size < CID_LENGTH) {
                throw new RepoProofError("car-malformed", "truncated section")
            }
            const cid = section.subarray(0, CID_LENGTH)
            if (!bytesEqual(cid.subarray(0, 4), CID_PREFIX)) {
                throw new RepoProofError(
                    "car-malformed",
                    "only CIDv1 dag-cbor sha2-256 blocks are accepted"
                )
            }
            const data = section.subarray(CID_LENGTH)
            const kind = classify(data, cid, root, expected.collection)
            if (kind === "drop") continue
            if (!bytesEqual(sha256(data), cid.subarray(4))) {
                throw new RepoProofError(
                    "block-cid-mismatch",
                    "block bytes do not hash to their CID"
                )
            }
            if (kind === "node" && ++nodes > expected.maxNodes) {
                throw new RepoCollectionError(
                    "node-cap-exceeded",
                    "too many MST nodes"
                )
            }
            blocks.set(cidToString(cid), data.slice())
        }
        pending = pending.slice(offset)
    }

    for await (const chunk of car) {
        total += chunk.length
        if (total > expected.maxBytes) {
            throw new RepoCollectionError(
                "byte-cap-exceeded",
                "CAR exceeds the byte cap"
            )
        }
        incoming.push(chunk)
        incomingLength += chunk.length
        if (pending.length + incomingLength < needed) continue
        const joined = new Uint8Array(pending.length + incomingLength)
        joined.set(pending)
        let at = pending.length
        for (const part of incoming) {
            joined.set(part, at)
            at += part.length
        }
        incoming.length = 0
        incomingLength = 0
        pending = joined
        consume()
    }
    if (root === null) {
        throw new RepoProofError("car-malformed", "empty CAR")
    }
    if (pending.length + incomingLength > 0) {
        throw new RepoProofError("car-malformed", "truncated section")
    }
    return { root: cidToString(root), blocks }
}

function tryReadVarint(
    bytes: Uint8Array,
    offset: number
): [number, number] | null {
    let value = 0
    for (let i = 0; i < 8; i++) {
        if (offset + i >= bytes.length) return null
        const byte = bytes[offset + i]!
        value += (byte & 0x7f) * 2 ** (7 * i)
        if ((byte & 0x80) === 0) return [value, offset + i + 1]
    }
    throw new RepoProofError("car-malformed", "varint too long")
}

function parseHeaderRoot(header: Uint8Array): Uint8Array {
    let value: unknown
    try {
        value = decodeCbor(header)
    } catch {
        throw new RepoProofError("car-malformed", "undecodable header")
    }
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        !Array.isArray(value.roots) ||
        value.roots.length < 1 ||
        !(value.roots[0] instanceof CidLink)
    ) {
        throw new RepoProofError("car-malformed", "not a CARv1 with a root")
    }
    return value.roots[0].bytes
}

type BlockKind = "commit" | "node" | "record" | "drop"

function classify(
    data: Uint8Array,
    cid: Uint8Array,
    root: Uint8Array,
    collection: string
): BlockKind {
    if (bytesEqual(cid, root)) return "commit"
    let value: unknown
    try {
        value = decodeCbor(data)
    } catch {
        return "drop"
    }
    if (!isRecord(value)) return "drop"
    if (Array.isArray(value.e) && "l" in value) return "node"
    const type = value.$type
    return type === undefined || typeof type !== "string" || type === collection
        ? "record"
        : "drop"
}

function walkCollection(
    kept: KeptBlocks,
    expected: RepoCollectionExpectation
): VerifiedCollection {
    const commitBytes = kept.blocks.get(kept.root)
    if (!commitBytes) {
        throw new RepoProofError("commit-malformed", "root block missing")
    }
    const commit: Commit = parseCommit(commitBytes)
    if (commit.did !== expected.did) {
        throw new RepoProofError("did-mismatch", "commit is for a different DID")
    }
    verifyCommitSignature(commit, expected.signingKey)

    const encoder = new TextEncoder()
    const prefix = encoder.encode(`${expected.collection}/`)
    const upper = encoder.encode(`${expected.collection}0`)
    const records: CollectionRecord[] = []
    const walked = new Set<string>()
    const decoded = new Map<string, unknown>()
    const decoder = new TextDecoder()

    // Key order inside a node is not checked by `decodeNode`, but the range
    // pruning relies on it, so it is enforced here.
    const visit = (link: CidLink | null, depth: number): void => {
        if (link === null) return
        if (depth > MAX_MST_DEPTH) {
            throw new RepoProofError("mst-malformed", "tree too deep")
        }
        const nodeCid = cidToString(link.bytes)
        // Key ranges of subtrees are disjoint, so an honest tree never links
        // one node twice; refusing repeats bounds the walk by the kept nodes.
        if (walked.has(nodeCid)) {
            throw new RepoProofError("mst-malformed", "MST node linked twice")
        }
        walked.add(nodeCid)
        const bytes = kept.blocks.get(nodeCid)
        if (!bytes) {
            throw new RepoProofError(
                "mst-malformed",
                "MST node missing or undecodable"
            )
        }
        const node = decodeNode(bytes)
        for (let i = 1; i < node.entries.length; i++) {
            if (compareBytes(node.entries[i - 1]!.key, node.entries[i]!.key) >= 0) {
                throw new RepoProofError("mst-malformed", "MST keys out of order")
            }
        }
        const first = node.entries[0]
        if (first === undefined || compareBytes(first.key, prefix) > 0) {
            visit(node.left, depth + 1)
        }
        node.entries.forEach((entry, index) => {
            if (compareBytes(entry.key, upper) >= 0) return
            const next = node.entries[index + 1]
            if (compareBytes(entry.key, prefix) >= 0) {
                records.push(readRecord(entry.key, entry.value))
            }
            if (next === undefined || compareBytes(next.key, prefix) > 0) {
                visit(entry.right, depth + 1)
            }
        })
    }

    const readRecord = (key: Uint8Array, link: CidLink): CollectionRecord => {
        const cid = cidToString(link.bytes)
        const rkey = decoder.decode(key.subarray(prefix.length))
        if (decoded.has(cid)) return { rkey, cid, record: decoded.get(cid) }
        const block = kept.blocks.get(cid)
        if (!block) {
            throw new RepoCollectionError(
                "block-missing",
                `record block for ${rkey} missing, or not of the collection`
            )
        }
        let record: unknown
        try {
            record = decodeCbor(block)
        } catch {
            throw new RepoProofError("mst-malformed", "undecodable record")
        }
        decoded.set(cid, record)
        return { rkey, cid, record }
    }

    visit(commit.data, 0)
    return { rev: commit.rev, records }
}
