/**
 * The change digest: a Bloom filter over the DIDs whose records changed in
 * one window.
 *
 * This surface exists for the population the other two cannot serve without
 * cost — DIDs a device cares about that carry no public signal
 * (`spec/key-transparency.md`). The monitor publishes what changed and
 * learns nothing about who cares; the device tests its private set locally
 * and fetches only the hits. So the filter is **identical bytes for every
 * caller**, and asking for it discloses nothing.
 *
 * A false positive costs one verified fetch that finds nothing new —
 * indistinguishable from the polling a device would do without a digest at
 * all. That is why the parameters below aim at "small and cheap" rather
 * than at a vanishing error rate: the failure is a wasted round trip, not a
 * wrong answer. False negatives cannot occur; a Bloom filter has none.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import {
    decodeCoseArray,
    encodeCose,
    type CoseValue,
} from "@germ-network/atproto-pmr-core"

/**
 * A sealed window, self-describing so a client needs no out-of-band
 * parameters to test against it — and so the monitor can change its sizing
 * without coordinating a flag day.
 */
export interface DigestWindow {
    /** Which window: `floor(epochMs / widthMs)`, so a client can compute it. */
    window: number
    /** Width in milliseconds, published rather than assumed. */
    widthMs: number
    /** Filter length in **bits**. Not derivable from the byte length alone. */
    bits: number
    /** Hash count. */
    hashes: number
    filter: Uint8Array
}

/** The window an instant falls in. Integer division, so it is stable. */
export function windowOf(epochMs: number, widthMs: number): number {
    return Math.floor(epochMs / widthMs)
}

/**
 * The smallest filter worth publishing, in bits.
 *
 * The textbook sizing is asymptotic and behaves badly at the populations
 * this surface actually sees. A single-member window computes `m = 10`,
 * `k = 7` — seven hashes into ten bits saturates the filter, giving a
 * false-positive rate near 8% against a 1% target. Since a quiet window is
 * the *common* case here, not an edge, the floor matters more than the
 * formula: 64 bits costs eight bytes and drops that rate by orders of
 * magnitude.
 */
const MIN_BITS = 64

/**
 * A ceiling on hash count.
 *
 * `k` grows without bound as `m/n` grows, and past a point each additional
 * hash costs sealing and lookup time while buying error rate that is
 * already far below what a wasted fetch justifies.
 */
const MAX_HASHES = 16

/**
 * Bloom sizing for `n` members at a target false-positive rate: the
 * textbook `m = -n·ln(p) / (ln2)²`, `k = (m/n)·ln2`, floored and capped
 * for the small populations this surface sees.
 *
 * An empty window still gets a usable filter, because a client must be
 * able to test against it and get "no" rather than fail to parse it.
 */
export function sizeFor(n: number, falsePositiveRate = 0.01): {
    bits: number
    hashes: number
} {
    if (n <= 0) return { bits: MIN_BITS, hashes: 1 }
    const ideal = Math.ceil((-n * Math.log(falsePositiveRate)) / Math.LN2 ** 2)
    const bits = Math.max(MIN_BITS, ideal)
    const hashes = Math.min(
        MAX_HASHES,
        Math.max(1, Math.round((bits / n) * Math.LN2))
    )
    return { bits, hashes }
}

/**
 * The k bit positions for one member.
 *
 * Kirsch–Mitzenmacher double hashing: two independent values taken from
 * one SHA-256, combined as `h1 + i·h2`, which is proven to preserve the
 * false-positive bound without computing k separate digests. One hash per
 * member rather than k is what keeps sealing cheap.
 *
 * **This function is the wire format.** A client that indexes bits
 * differently reads a different filter and silently misses changes, so the
 * byte order, the modulo, and the input encoding are all pinned by test
 * vectors rather than left to convention.
 */
function positions(did: string, bits: number, hashes: number): number[] {
    const digest = sha256(new TextEncoder().encode(did))
    // Big-endian, first 8 bytes and second 8 bytes, as unsigned.
    let h1 = 0n
    let h2 = 0n
    for (let i = 0; i < 8; i++) h1 = (h1 << 8n) | BigInt(digest[i])
    for (let i = 8; i < 16; i++) h2 = (h2 << 8n) | BigInt(digest[i])

    // **Enhanced** double hashing — `h1 + i·h2 + i²` (Dillinger & Manolios)
    // — not the plain `h1 + i·h2` form.
    //
    // Plain double hashing degenerates badly at a power-of-two filter
    // size, which the 64-bit floor makes the common case here. If `h2` is
    // divisible by `m`, every one of the k positions collapses onto a
    // single bit; if `h2 ≡ 1`, they come out consecutive. Neither is
    // visible from a membership test — the filter still answers `true` for
    // everything it contains — so what degrades is only the
    // false-positive rate, silently, which is exactly the kind of fault
    // that survives a green test suite. The quadratic term breaks both
    // cases regardless of how `m` factors, and `h2 |= 1` keeps it coprime
    // with any power of two.
    h2 |= 1n

    const m = BigInt(bits)
    const out: number[] = []
    for (let i = 0n; i < BigInt(hashes); i++) {
        out.push(Number((((h1 + i * h2 + i * i) % m) + m) % m))
    }
    return out
}

/** Seal a window's membership into a filter. */
export function sealWindow(
    window: number,
    widthMs: number,
    dids: readonly string[],
    falsePositiveRate = 0.01
): DigestWindow {
    const { bits, hashes } = sizeFor(dids.length, falsePositiveRate)
    const filter = new Uint8Array(Math.ceil(bits / 8))
    for (const did of dids) {
        for (const p of positions(did, bits, hashes)) {
            filter[p >> 3] |= 1 << (p & 7)
        }
    }
    return { window, widthMs, bits, hashes, filter }
}

/**
 * Test one DID against a sealed window.
 *
 * `false` is definitive — that DID did not change in this window. `true`
 * means "probably, go and check", which is the only answer a Bloom filter
 * can give and the only one this surface needs: the client's next step is
 * an authoritative fetch either way.
 */
export function mightHaveChanged(w: DigestWindow, did: string): boolean {
    for (const p of positions(did, w.bits, w.hashes)) {
        if ((w.filter[p >> 3] & (1 << (p & 7))) === 0) return false
    }
    return true
}

/**
 * The wire form: deterministic CBOR, matching every other body in this
 * protocol (`spec/wire-api.md`, "Deterministic CBOR"). An array, because
 * catch-up spans `[cursor, now]` as a *sequence* of per-window filters
 * rather than their union — a union's false-positive rate degrades as
 * windows merge, and the sequence stays exact for the price of a few bytes
 * at this population.
 *
 * Short keys because this body is fetched often and is pure overhead
 * otherwise: `w` window, `d` width, `b` bits, `k` hashes, `f` filter.
 */
export function encodeDigestWindows(windows: readonly DigestWindow[]): Uint8Array {
    return encodeCose(
        windows.map(
            (w) =>
                new Map<string, CoseValue>([
                    ["w", w.window],
                    ["d", w.widthMs],
                    ["b", w.bits],
                    ["k", w.hashes],
                    ["f", w.filter],
                ])
        )
    )
}

export function decodeDigestWindows(bytes: Uint8Array): DigestWindow[] {
    return decodeCoseArray(bytes).map((entry) => {
        const m = asMap(entry)
        const window = asNumber(m.get("w"), "w")
        const widthMs = asNumber(m.get("d"), "d")
        const bits = asNumber(m.get("b"), "b")
        const hashes = asNumber(m.get("k"), "k")
        const filter = m.get("f")
        if (!(filter instanceof Uint8Array)) {
            throw new Error("digest: filter must be bytes")
        }
        if (bits <= 0 || hashes <= 0 || filter.byteLength < Math.ceil(bits / 8)) {
            // A filter shorter than its own declared length would read past
            // the end and answer "no" for every DID — a silent all-clear.
            throw new Error("digest: filter is shorter than its declared bit length")
        }
        return { window, widthMs, bits, hashes, filter }
    })
}

function asMap(value: CoseValue): Map<string, CoseValue> {
    if (!(value instanceof Map)) throw new Error("digest: expected a map")
    return value as Map<string, CoseValue>
}

function asNumber(value: CoseValue | undefined, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`digest: ${field} must be a number`)
    }
    return value
}
