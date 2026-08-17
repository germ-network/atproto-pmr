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
    decodeCoseMap,
    encodeCose,
    type CoseValue,
} from "@germ-network/atproto-pmr-core"
import type { MonitorIndex, SnapshotStore } from "./storage"

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

/**
 * The window an instant falls in, identified by its **start instant** in
 * epoch milliseconds — not by an index.
 *
 * An index (`floor(ms / width)`) is ambiguous the moment the width is
 * tuned: index `5` means minutes 50–60 at a ten-minute width and 25–30 at
 * a five-minute one, so windows sealed under different widths collide on
 * the same storage key with different meanings, and a client asking for
 * "window 5" gets an answer to a question it did not ask. A start instant
 * names a point in time under any width, so changing the width alters
 * granularity going forward and leaves every sealed window addressable.
 *
 * A client still computes the window it wants from a timestamp, and reads
 * `widthMs` off any window it already holds.
 */
export function windowOf(epochMs: number, widthMs: number): number {
    return Math.floor(epochMs / widthMs) * widthMs
}

/** The window after this one, under the same width. */
export function nextWindow(window: number, widthMs: number): number {
    return window + widthMs
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
 * What a digest request answers with.
 *
 * An envelope rather than a bare array, because three facts have to travel
 * with the windows and none of them is derivable from the windows alone:
 *
 * - `oldest` — the earliest window still retained. A client whose cursor
 *   predates it has lost coverage and MUST fall back to re-verifying its
 *   interest set directly. Without this, "past retention" and "nothing
 *   changed" are the same empty answer, and the failure is silent in
 *   exactly the case where coverage was lost.
 * - `sealedThrough` — the newest published window. Compare `nextCursor`
 *   against it to know whether to keep paging; a separate "truncated"
 *   flag would be a second source of the same truth, free to disagree.
 * - `nextCursor` — where to resume.
 */
export interface DigestPage {
    windows: DigestWindow[]
    oldest: number
    sealedThrough: number
    nextCursor: number
}

/**
 * The wire form: deterministic CBOR, matching every other body in this
 * protocol (`spec/wire-api.md`, "Deterministic CBOR"). The windows are a
 * *sequence* rather than a union — a union's false-positive rate degrades
 * as windows merge, and the sequence stays exact for a few bytes at this
 * population.
 *
 * Short keys because this body is fetched often and is otherwise pure
 * overhead: `w` window, `d` width, `b` bits, `k` hashes, `f` filter; and
 * on the envelope `s` windows, `o` oldest, `t` sealedThrough, `n` next.
 */
export function encodeDigestPage(page: DigestPage): Uint8Array {
    return encodeCose(
        new Map<string, CoseValue>([
            ["n", page.nextCursor],
            ["o", page.oldest],
            ["s", page.windows.map(encodeWindowMap)],
            ["t", page.sealedThrough],
        ])
    )
}

export function decodeDigestPage(bytes: Uint8Array): DigestPage {
    const m = asMap(decodeCoseMap(bytes) as CoseValue)
    const windows = m.get("s")
    if (!Array.isArray(windows)) throw new Error("digest: windows must be an array")
    return {
        windows: windows.map(decodeWindowMap),
        oldest: asNumber(m.get("o"), "o"),
        sealedThrough: asNumber(m.get("t"), "t"),
        nextCursor: asNumber(m.get("n"), "n"),
    }
}

function encodeWindowMap(w: DigestWindow): Map<string, CoseValue> {
    return new Map<string, CoseValue>([
        ["b", w.bits],
        ["d", w.widthMs],
        ["f", w.filter],
        ["k", w.hashes],
        ["w", w.window],
    ])
}

/** One window on its own — what a sealed window is stored as. */
export function encodeDigestWindows(windows: readonly DigestWindow[]): Uint8Array {
    return encodeCose(windows.map(encodeWindowMap))
}

export function decodeDigestWindows(bytes: Uint8Array): DigestWindow[] {
    return decodeCoseArray(bytes).map((entry) => decodeWindowMap(entry))
}

function decodeWindowMap(entry: CoseValue): DigestWindow {
    {
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
    }
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

/** What sealing needs: the writer, the serving store, and the geometry. */
export interface SealDeps {
    index: MonitorIndex
    snapshot: SnapshotStore
    /** Window width. Published with every filter, so it may change. */
    widthMs: number
    nowMs(): number
}

/**
 * Seal every window that has closed since the last pass.
 *
 * Only *closed* windows are ever sealed, and therefore only closed windows
 * are ever served: the current one is still accumulating, so publishing it
 * would return different bytes to two callers a second apart — breaking
 * both cacheability and the identical-bytes-for-every-caller property the
 * privacy argument rests on. The cost is a latency floor: a change is
 * invisible to the digest for up to one window width.
 *
 * `sealedThrough` advances to the last closed window whether or not
 * anything was in it, which is what lets a reader tell "nothing changed"
 * from "not published yet" without materialising empty filters.
 */
export async function sealDueWindows(deps: SealDeps, limit = 16): Promise<number[]> {
    const current = windowOf(deps.nowMs(), deps.widthMs)
    const due = await deps.index.closedWindowsWithMembers(current, limit)

    const sealed: number[] = []
    for (const w of due) {
        const members = await deps.index.windowMembers(w)
        const filter = sealWindow(w, deps.widthMs, members)
        // Bytes durable before the membership is dropped: the reverse
        // order loses the window entirely if the write fails, and a window
        // cannot be rebuilt — the events that fed it are long past.
        await deps.snapshot.putSealedWindow(String(w), encodeDigestWindows([filter]))
        await deps.index.dropWindow(w)
        sealed.push(w)
    }

    // Only claim up to what was actually processed: if the limit truncated
    // the batch, windows beyond it still hold members and must not be
    // reported as sealed-and-empty.
    const claimable =
        due.length === limit && due.length > 0
            ? Math.max(...due)
            : current - deps.widthMs
    const previous = await deps.index.readSealedThrough()
    if (previous === null || claimable > previous) {
        await deps.index.setSealedThrough(claimable)
    }
    return sealed
}

/** What serving a digest request needs. */
export interface ServeDeps {
    index: MonitorIndex
    snapshot: SnapshotStore
    widthMs: number
    /**
     * How many bytes of filters to return before deferring the rest to the
     * next page.
     *
     * A **byte** budget rather than a window count, deliberately: a count
     * is the thing that goes stale as the population grows. The same 144
     * windows are a few kilobytes at a quiet change rate and approaching a
     * megabyte at a hundred times it, so a count has to be re-tuned by
     * hand exactly when nobody is looking. A budget self-adjusts — fatter
     * windows simply mean fewer per page and more paging — and it is the
     * quantity an operator can actually observe in production.
     */
    byteBudget: number
    /** How long a sealed window is retained, for the `oldest` floor. */
    retentionMs: number
    nowMs(): number
}

/**
 * Serve `[from, sealedThrough]`, up to the byte budget.
 *
 * Empty windows are synthesised rather than stored: a quiet interval is a
 * real answer a client needs — "nothing changed here" — and materialising
 * a filter for every one of them would cost storage proportional to time
 * rather than to change.
 */
export async function serveDigest(
    deps: ServeDeps,
    from: number
): Promise<DigestPage> {
    const now = deps.nowMs()
    const sealedThrough =
        (await deps.index.readSealedThrough()) ??
        windowOf(now, deps.widthMs) - deps.widthMs
    const oldest = windowOf(now - deps.retentionMs, deps.widthMs)

    // Never start below the floor: a cursor that predates retention is a
    // gap the client must close by re-verifying, and `oldest` is how it
    // finds out. Serving from the floor instead would look like coverage.
    let cursor = Math.max(windowOf(from, deps.widthMs), oldest)

    const windows: DigestWindow[] = []
    let spent = 0
    while (cursor <= sealedThrough && spent < deps.byteBudget) {
        const stored = await deps.snapshot.getSealedWindow(String(cursor))
        const w =
            stored === null
                ? sealWindow(cursor, deps.widthMs, [])
                : decodeDigestWindows(stored)[0]
        windows.push(w)
        spent += w.filter.byteLength
        cursor = nextWindow(cursor, deps.widthMs)
    }

    return { windows, oldest, sealedThrough, nextCursor: cursor }
}
