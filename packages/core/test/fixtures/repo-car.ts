/**
 * Builds signed single-repo CARs (commit + MST + record blocks) for the
 * repo-proof and snapshot-resolver tests, with hooks for tampering.
 */
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { Token, Type, encode } from "cborg"

export class Link {
    constructor(readonly bytes: Uint8Array) {}
}

export function encodeDagCbor(value: unknown): Uint8Array {
    return encode(value, {
        typeEncoders: {
            Object: (obj: unknown) => {
                if (obj instanceof Link) {
                    const bytes = new Uint8Array(obj.bytes.length + 1)
                    bytes.set(obj.bytes, 1)
                    return [new Token(Type.tag, 42), new Token(Type.bytes, bytes)]
                }
                return null
            },
        },
    })
}

export function cidOf(data: Uint8Array): Uint8Array {
    return Uint8Array.of(0x01, 0x71, 0x12, 0x20, ...sha256(data))
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567"
export function cidString(cid: Uint8Array): string {
    let out = ""
    let acc = 0
    let bits = 0
    for (const byte of cid) {
        acc = (acc << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += B32[(acc >>> (bits - 5)) & 31]
            bits -= 5
        }
        acc &= (1 << bits) - 1
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
    return `b${out}`
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function base58Encode(bytes: Uint8Array): string {
    const digits: number[] = []
    for (const byte of bytes) {
        let carry = byte
        for (let i = 0; i < digits.length; i++) {
            carry += digits[i]! << 8
            digits[i] = carry % 58
            carry = (carry / 58) | 0
        }
        while (carry > 0) {
            digits.push(carry % 58)
            carry = (carry / 58) | 0
        }
    }
    let out = ""
    for (const byte of bytes) {
        if (byte !== 0) break
        out += "1"
    }
    for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]!]
    return out
}

export type CurveName = "secp256k1" | "p256"

export interface TestKey {
    curve: CurveName
    secretKey: Uint8Array
    /** `publicKeyMultibase` as in a DID document. */
    multikey: string
}

export function makeKey(curve: CurveName = "secp256k1"): TestKey {
    const impl = curve === "secp256k1" ? secp256k1 : p256
    const secretKey = impl.utils.randomSecretKey()
    const publicKey = impl.getPublicKey(secretKey, true)
    const prefix =
        curve === "secp256k1" ? Uint8Array.of(0xe7, 0x01) : Uint8Array.of(0x80, 0x24)
    const multikey = "z" + base58Encode(Uint8Array.of(...prefix, ...publicKey))
    return { curve, secretKey, multikey }
}

const ORDERS: Record<CurveName, bigint> = {
    secp256k1:
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    p256: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
}

export function sign(key: TestKey, message: Uint8Array): Uint8Array {
    const impl = key.curve === "secp256k1" ? secp256k1 : p256
    return impl.sign(message, key.secretKey, { prehash: true, lowS: true })
}

/** The same signature with s replaced by n - s (valid ECDSA, but high-S). */
export function highS(key: TestKey, sig: Uint8Array): Uint8Array {
    let s = 0n
    for (const byte of sig.subarray(32)) s = (s << 8n) | BigInt(byte)
    let flipped = ORDERS[key.curve] - s
    const out = Uint8Array.from(sig)
    for (let i = 63; i >= 32; i--) {
        out[i] = Number(flipped & 0xffn)
        flipped >>= 8n
    }
    return out
}

export function layerOf(key: string): number {
    const hash = sha256(new TextEncoder().encode(key))
    let layer = 0
    for (const byte of hash) {
        for (let shift = 6; shift >= 0; shift -= 2) {
            if (((byte >> shift) & 3) !== 0) return layer
            layer++
        }
    }
    return layer
}

export interface Block {
    cid: Uint8Array
    data: Uint8Array
}

function varint(n: number): number[] {
    const out: number[] = []
    while (n >= 0x80) {
        out.push((n & 0x7f) | 0x80)
        n = Math.floor(n / 128)
    }
    out.push(n)
    return out
}

export function encodeCar(
    root: Uint8Array | Uint8Array[],
    blocks: Block[]
): Uint8Array {
    const roots = Array.isArray(root) ? root : [root]
    const header = encodeDagCbor({
        version: 1,
        roots: roots.map((r) => new Link(r)),
    })
    const parts: number[] = [...varint(header.length), ...header]
    for (const block of blocks) {
        parts.push(...varint(block.cid.length + block.data.length))
        parts.push(...block.cid, ...block.data)
    }
    return Uint8Array.from(parts)
}

function buildMst(
    items: Array<{ key: string; layer: number; value: Uint8Array }>,
    level: number,
    blocks: Block[]
): Uint8Array | null {
    if (items.length === 0) return null
    const entries: Array<{ item: (typeof items)[number]; right: Item[] }> = []
    type Item = (typeof items)[number]
    let left: Item[] = []
    for (const item of items) {
        if (item.layer === level) {
            entries.push({ item, right: [] })
        } else if (entries.length === 0) {
            left.push(item)
        } else {
            entries[entries.length - 1]!.right.push(item)
        }
    }
    const subtree = (group: Item[]): Link | null => {
        if (group.length === 0) return null
        const cid = buildMst(group, level - 1, blocks)
        return cid ? new Link(cid) : null
    }
    const l = subtree(left)
    let previous = new Uint8Array(0)
    const e = entries.map(({ item, right }) => {
        const key = new TextEncoder().encode(item.key)
        let p = 0
        while (p < previous.length && p < key.length && previous[p] === key[p]) p++
        previous = key
        return {
            p,
            k: key.subarray(p),
            v: new Link(item.value),
            t: subtree(right),
        }
    })
    left = []
    const data = encodeDagCbor({ l, e })
    const cid = cidOf(data)
    blocks.push({ cid, data })
    return cid
}

export interface BuiltRepo {
    car: Uint8Array
    /** Block order as written to the CAR (commit first). */
    blocks: Block[]
    root: Uint8Array
    commitBlock: Block
    recordCids: Record<string, string>
    key: TestKey
}

export interface BuildOptions {
    did: string
    /** `"<collection>/<rkey>"` → record. */
    records: Record<string, unknown>
    key?: TestKey
    rev?: string
    version?: number
    /** Defaults to `did`. */
    commitDid?: string
    /** Sign with this key instead of `key` (the DID document still lists `key`). */
    signWith?: TestKey
    /** Replace the signature after signing. */
    mutateSig?: (sig: Uint8Array, key: TestKey) => Uint8Array
}

export function buildRepoCar(options: BuildOptions): BuiltRepo {
    const key = options.key ?? makeKey()
    const blocks: Block[] = []
    const recordCids: Record<string, string> = {}
    const items = Object.keys(options.records)
        .sort()
        .map((path) => {
            const data = encodeDagCbor(options.records[path])
            const cid = cidOf(data)
            blocks.push({ cid, data })
            recordCids[path] = cidString(cid)
            return { key: path, layer: layerOf(path), value: cid }
        })
    const top = items.reduce((max, item) => Math.max(max, item.layer), 0)
    const mstRoot = buildMst(items, top, blocks)
    const unsigned = {
        did: options.commitDid ?? options.did,
        version: options.version ?? 3,
        data: mstRoot ? new Link(mstRoot) : null,
        rev: options.rev ?? "3kaaaaaaaaaaa",
        prev: null,
    }
    let sig = sign(options.signWith ?? key, encodeDagCbor(unsigned))
    if (options.mutateSig) sig = options.mutateSig(sig, key)
    const commitData = encodeDagCbor({ ...unsigned, sig })
    const commitBlock = { cid: cidOf(commitData), data: commitData }
    const ordered = [commitBlock, ...blocks]
    return {
        car: encodeCar(commitBlock.cid, ordered),
        blocks: ordered,
        root: commitBlock.cid,
        commitBlock,
        recordCids,
        key,
    }
}
