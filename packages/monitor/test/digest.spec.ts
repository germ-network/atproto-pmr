/**
 * The change digest.
 *
 * Two classes of property here, and they are not equally forgiving. The
 * **no-false-negative** guarantee is load-bearing: a DID that changed and
 * tests `false` is a change the device never learns about, which is exactly
 * the withholding this component exists to detect. The false-positive rate
 * is a cost question — a wasted verified fetch — so it is checked for
 * sanity rather than pinned.
 *
 * The bit-position vectors are pinned because `positions()` IS the wire
 * format: a client that indexes differently reads a different filter and
 * silently misses changes. That failure is invisible from either side,
 * which is why it gets known-answer coverage rather than a round trip.
 */
import { describe, expect, it } from "vitest"
import {
    decodeDigestWindows,
    encodeDigestWindows,
    mightHaveChanged,
    decodeDigestPage,
    encodeDigestPage,
    sealDueWindows,
    sealWindow,
    serveDigest,
    sizeFor,
    windowOf,
    type DigestWindow,
    type SealDeps,
    type ServeDeps,
} from "../src/digest"

const WIDTH = 600_000 // ten minutes
const DIDS = [
    "did:plc:alice00000000000000000",
    "did:plc:bob000000000000000000",
    "did:plc:carol0000000000000000",
]

describe("windowOf", () => {
    it("is stable across an interval and advances at the boundary", () => {
        const base = windowOf(1_786_695_916_763, WIDTH)
        expect(windowOf(1_786_695_916_763 + 1, WIDTH)).toBe(base)
        expect(windowOf(base + WIDTH, WIDTH)).toBe(base + WIDTH)
    })

    it("is computable by a client from a timestamp alone", () => {
        // The client has to know which windows to ask for without being
        // told, which is why this is arithmetic rather than a server counter.
        expect(windowOf(0, WIDTH)).toBe(0)
        expect(windowOf(WIDTH - 1, WIDTH)).toBe(0)
        expect(windowOf(WIDTH, WIDTH)).toBe(WIDTH)
    })

    it("identifies a window by its START INSTANT, so width can be tuned", () => {
        // An index would collide across widths: index 5 is minutes 50-60
        // at a ten-minute width and 25-30 at five, so windows sealed under
        // different widths would share a storage key and mean different
        // things. An instant is unambiguous under any width.
        const t = 1_786_695_916_763
        const wide = windowOf(t, 600_000)
        const narrow = windowOf(t, 300_000)
        expect(wide % 600_000).toBe(0)
        expect(narrow % 300_000).toBe(0)
        // Same instant, two widths, two DIFFERENT identifiers — which is
        // the property that makes retuning safe.
        expect(wide).not.toBe(narrow)
        expect(narrow).toBeGreaterThan(wide)
    })
})

describe("membership", () => {
    it("NEVER answers false for a DID that changed", () => {
        // The one guarantee that must not bend: a false negative is a
        // change the device never hears about.
        const w = sealWindow(1, WIDTH, DIDS)
        for (const did of DIDS) expect(mightHaveChanged(w, did)).toBe(true)
    })

    it("answers false for absent DIDs, which is what makes it useful", () => {
        const w = sealWindow(1, WIDTH, DIDS)
        const absent = Array.from({ length: 200 }, (_, i) => `did:plc:absent${i}`)
        const hits = absent.filter((d) => mightHaveChanged(w, d))
        // A filter that said "maybe" to everything would be correct and
        // useless — the device would fetch its whole interest set.
        expect(hits.length).toBeLessThan(absent.length / 10)
    })

    it("holds no-false-negatives at a realistic population", () => {
        const many = Array.from({ length: 500 }, (_, i) => `did:plc:member${i}`)
        const w = sealWindow(7, WIDTH, many)
        for (const did of many) expect(mightHaveChanged(w, did)).toBe(true)
    })

    it("keeps the false-positive rate near its target", () => {
        const many = Array.from({ length: 500 }, (_, i) => `did:plc:member${i}`)
        const w = sealWindow(7, WIDTH, many, 0.01)
        const absent = Array.from({ length: 2000 }, (_, i) => `did:plc:other${i}`)
        const rate = absent.filter((d) => mightHaveChanged(w, d)).length / absent.length
        // Sanity, not a pin: sizing is arithmetic, and a rate far above
        // target would mean the bit indexing is not spreading.
        expect(rate).toBeLessThan(0.05)
    })

    it("an empty window is testable and answers false", () => {
        // A device polling a quiet network must get a parseable "nothing",
        // not a filter it cannot read.
        const w = sealWindow(2, WIDTH, [])
        expect(mightHaveChanged(w, DIDS[0])).toBe(false)
    })
})

describe("sizing", () => {
    it("scales with the population, above a floor", () => {
        // The floor is the point: the textbook formula gives 10 bits for a
        // single member, and seven hashes into ten bits saturates. A quiet
        // window is the common case here, so it gets 64 bits — eight
        // bytes — rather than a filter that answers "maybe" to everything.
        expect(sizeFor(0).bits).toBe(64)
        expect(sizeFor(1).bits).toBe(64)
        expect(sizeFor(10).bits).toBeLessThan(sizeFor(1000).bits)
        expect(sizeFor(1000).hashes).toBeGreaterThan(1)
        // And a cap, so k cannot grow without bound as m/n does.
        expect(sizeFor(1).hashes).toBeLessThanOrEqual(16)
    })
})

describe("the wire format", () => {
    it("round-trips through deterministic CBOR", () => {
        const sealed = [sealWindow(1, WIDTH, DIDS), sealWindow(2, WIDTH, [])]
        const back = decodeDigestWindows(encodeDigestWindows(sealed))
        expect(back).toHaveLength(2)
        expect(back[0].window).toBe(1)
        expect(back[0].widthMs).toBe(WIDTH)
        expect([...back[0].filter]).toEqual([...sealed[0].filter])
        // And the decoded form still answers correctly — the parameters
        // travelled with it, which is the point of self-description.
        for (const did of DIDS) expect(mightHaveChanged(back[0], did)).toBe(true)
    })

    it("is self-describing, so a client needs no out-of-band parameters", () => {
        const [w] = decodeDigestWindows(encodeDigestWindows([sealWindow(3, WIDTH, DIDS)]))
        expect(w.bits).toBeGreaterThan(0)
        expect(w.hashes).toBeGreaterThan(0)
        expect(w.widthMs).toBe(WIDTH)
    })

    it("REFUSES a filter shorter than its declared bit length", () => {
        // Reading past the end answers "no" for every DID — a silent
        // all-clear, which is the worst possible failure for this surface.
        const good = sealWindow(1, WIDTH, DIDS)
        const truncated: DigestWindow = { ...good, filter: good.filter.slice(0, 1) }
        expect(() => decodeDigestWindows(encodeDigestWindows([truncated]))).toThrow(
            /shorter than its declared/
        )
    })

    it("refuses a filter that is not bytes", () => {
        expect(() =>
            decodeDigestWindows(
                encodeDigestWindows([{ ...sealWindow(1, WIDTH, []), bits: 0 }])
            )
        ).toThrow()
    })
})

describe("bit spreading", () => {
    it("gives each member k DISTINCT positions, not a collapsed cluster", () => {
        // The failure this guards is invisible to membership tests: a
        // filter whose k hashes land on one bit answers `true` for
        // everything it contains, and merely destroys the false-positive
        // rate. Checked across many DIDs because it depended on the hash
        // value, so a single fixture would have missed it — an earlier
        // draft produced exactly one bit for all sixteen hashes.
        //
        // Not asserting k distinct positions: the quadratic term collides
        // sometimes, and measured over 2000 DIDs the count ranges 8..16 of
        // 16 (mode 16). The bound below is well under that floor, because
        // what must never happen is collapse, and the aggregate error rate
        // is pinned by the test after this one.
        for (let i = 0; i < 200; i++) {
            const w = sealWindow(1, WIDTH, [`did:plc:spread${i}`])
            let set = 0
            for (let b = 0; b < w.bits; b++) {
                if ((w.filter[b >> 3] & (1 << (b & 7))) !== 0) set++
            }
            expect(set * 4).toBeGreaterThanOrEqual(w.hashes)
        }
    })

    it("keeps the rate near target at the small windows this actually sees", () => {
        // germ's real rate is a handful of changes per window, which is
        // where the textbook sizing behaves worst — so it is where the
        // floor and the cap have to earn their place.
        for (const n of [1, 4, 20]) {
            const members = Array.from({ length: n }, (_, i) => `did:plc:small${i}`)
            const w = sealWindow(1, WIDTH, members)
            const absent = Array.from({ length: 2000 }, (_, i) => `did:plc:gone${i}`)
            const rate = absent.filter((d) => mightHaveChanged(w, d)).length / absent.length
            expect(rate).toBeLessThan(0.05)
            for (const d of members) expect(mightHaveChanged(w, d)).toBe(true)
        }
    })
})

describe("known answers — this is the wire format", () => {
    it("pins the bit positions for a fixed DID and geometry", () => {
        // Derived from this implementation, then frozen. If these change,
        // every already-deployed client reads a different filter and
        // silently misses changes — so a diff here is a wire break, not a
        // refactor. SHA-256 over the DID's UTF-8 bytes; h1 = big-endian
        // bytes 0..7, h2 = bytes 8..15 forced odd; position
        // i = (h1 + i·h2 + i²) mod bits.
        //
        // These 16 positions being spread rather than clustered is the
        // point: an earlier draft produced ONE bit for all sixteen hashes,
        // and every membership test still passed.
        const w = sealWindow(1, WIDTH, ["did:plc:alice00000000000000000"])
        const set: number[] = []
        for (let bit = 0; bit < w.bits; bit++) {
            if ((w.filter[bit >> 3] & (1 << (bit & 7))) !== 0) set.push(bit)
        }
        expect({ bits: w.bits, hashes: w.hashes, set }).toEqual({
            bits: 64,
            hashes: 16,
            set: [1, 3, 9, 11, 13, 25, 29, 31, 37, 39, 47, 49, 51, 53, 55, 59],
        })
    })
})

describe("sealing", () => {
    /** Minimal index + snapshot: only what sealing touches. */
    function sealHarness(
        seed: Record<number, string[]> = {},
        initialMarker: { sealedThrough: number; oldest: number } | null = null
    ) {
        const members = new Map<number, Set<string>>(
            Object.entries(seed).map(([w, d]) => [Number(w), new Set(d)])
        )
        const windows = new Map<string, Uint8Array>()
        let marker = initialMarker
        const deps = {
            index: {
                windowMembers: async (w: number) => [...(members.get(w) ?? [])].sort(),
                dropWindow: async (w: number) => void members.delete(w),
            },
            snapshot: {
                putSealedWindow: async (id: string, f: Uint8Array) => void windows.set(id, f),
                getSealedWindow: async (id: string) => windows.get(id) ?? null,
                getDigestMarker: async () => marker,
                putDigestMarker: async (m: { sealedThrough: number; oldest: number }) =>
                    void (marker = m),
            },
            widthMs: WIDTH,
            retentionMs: 20 * WIDTH,
            nowMs: () => 10 * WIDTH + 1, // current window is 10
        } as unknown as SealDeps
        return { deps, members, windows, marker: () => marker }
    }

    it("seals closed windows and leaves the current one accumulating", async () => {
        // The open window must never be published: it would return
        // different bytes to two callers a second apart, which breaks both
        // caching and the identical-bytes property. Window 9 is empty and
        // between the marker and the current window, so it seals too —
        // every window in range now gets a physical entry, not only the
        // ones with members.
        const h = sealHarness(
            { [8 * WIDTH]: ["did:plc:a"], [10 * WIDTH]: ["did:plc:current"] },
            { sealedThrough: 7 * WIDTH, oldest: 0 }
        )
        const sealed = await sealDueWindows(h.deps)
        expect(sealed).toEqual([8 * WIDTH, 9 * WIDTH])
        expect(h.windows.has(String(8 * WIDTH))).toBe(true)
        expect(h.windows.has(String(9 * WIDTH))).toBe(true)
        expect(h.windows.has(String(10 * WIDTH))).toBe(false)
        expect(h.members.has(10 * WIDTH)).toBe(true)
    })

    it("a sealed window still answers for its members", async () => {
        const h = sealHarness(
            { [8 * WIDTH]: ["did:plc:a", "did:plc:b"] },
            { sealedThrough: 7 * WIDTH, oldest: 0 }
        )
        await sealDueWindows(h.deps)
        const [w] = decodeDigestWindows(h.windows.get(String(8 * WIDTH))!)
        expect(mightHaveChanged(w, "did:plc:a")).toBe(true)
        expect(mightHaveChanged(w, "did:plc:b")).toBe(true)
        expect(mightHaveChanged(w, "did:plc:never")).toBe(false)
    })

    it("advances past EMPTY windows, writing a real entry for each", async () => {
        // Nothing observed is a real answer, but it is no longer implied by
        // a scalar advancing past it — `serveDigest` reads from a different
        // process now, so an empty window needs a physical entry to be told
        // apart from one that has not propagated here yet.
        const h = sealHarness({})
        const sealed = await sealDueWindows(h.deps)
        expect(sealed).toEqual([9 * WIDTH])
        expect(h.marker()?.sealedThrough).toBe(9 * WIDTH)
        expect(h.windows.has(String(9 * WIDTH))).toBe(true)
        const [w] = decodeDigestWindows(h.windows.get(String(9 * WIDTH))!)
        expect(mightHaveChanged(w, "did:plc:anyone")).toBe(false)
    })

    it("drops membership only after the filter is durable", async () => {
        // A window cannot be rebuilt — the events that fed it are past —
        // so losing it to a failed write would be permanent.
        const h = sealHarness(
            { [8 * WIDTH]: ["did:plc:a"] },
            { sealedThrough: 7 * WIDTH, oldest: 0 }
        )
        const failing = {
            ...h.deps,
            snapshot: {
                ...h.deps.snapshot,
                putSealedWindow: async () => {
                    throw new Error("KV down")
                },
            },
        } as unknown as SealDeps
        await expect(sealDueWindows(failing)).rejects.toThrow(/KV down/)
        expect(h.members.has(8 * WIDTH)).toBe(true)
    })

    it("does not claim windows the batch limit left behind", async () => {
        // Reporting sealed-through past an unprocessed window would make it
        // read as definitively empty — a silent all-clear.
        const h = sealHarness(
            { [2 * WIDTH]: ["did:plc:a"], [3 * WIDTH]: ["did:plc:b"], [4 * WIDTH]: ["did:plc:c"] },
            { sealedThrough: 1 * WIDTH, oldest: 0 }
        )
        const sealed = await sealDueWindows(h.deps, 2)
        expect(sealed).toEqual([2 * WIDTH, 3 * WIDTH])
        expect(h.marker()?.sealedThrough).toBe(3 * WIDTH)
        expect(h.members.has(4 * WIDTH)).toBe(true)
        expect(h.windows.has(String(4 * WIDTH))).toBe(false)
    })

    it("never moves sealedThrough backwards", async () => {
        const h = sealHarness({})
        await sealDueWindows(h.deps)
        expect(h.marker()?.sealedThrough).toBe(9 * WIDTH)
        const earlier = { ...h.deps, nowMs: () => 5 * WIDTH } as unknown as SealDeps
        await sealDueWindows(earlier)
        expect(h.marker()?.sealedThrough).toBe(9 * WIDTH)
    })

    it("a fresh install starts coverage now, never retroactively", async () => {
        // A monitor cannot claim to have observed a history it was not
        // running for — starting from the dawn of time on first boot would
        // be exactly that claim.
        const h = sealHarness({})
        expect(h.marker()).toBeNull()
        await sealDueWindows(h.deps)
        expect(h.marker()?.oldest).toBe(9 * WIDTH)
    })

    it("a retention INCREASE cannot move `oldest` earlier than what already expired", async () => {
        // The monotonic half of the fix: raising WINDOW_RETENTION_SECONDS
        // must not promise coverage back to a window whose KV bytes are
        // already gone under the old, shorter retention — that would wedge
        // serveDigest behind a floor it can never actually read past.
        const h = sealHarness({}, { sealedThrough: 9 * WIDTH, oldest: 8 * WIDTH })
        const raised = { ...h.deps, retentionMs: 1000 * WIDTH } as unknown as SealDeps
        await sealDueWindows({ ...raised, nowMs: () => 11 * WIDTH + 1 })
        expect(h.marker()?.oldest).toBe(8 * WIDTH)
    })
})

describe("serving a page", () => {
    type Marker = { sealedThrough: number; oldest: number }

    /** Every physical window entry in `[fromWindow, toWindowInclusive]`, empty. */
    function emptyRange(fromWindow: number, toWindowInclusive: number): Record<number, string[]> {
        const out: Record<number, string[]> = {}
        for (let w = fromWindow; w <= toWindowInclusive; w += WIDTH) out[w] = []
        return out
    }

    function serveHarness(
        sealed: Record<number, string[]> = {},
        marker: Marker | null,
        nowMs = 100 * WIDTH
    ) {
        const windows = new Map<string, Uint8Array>()
        for (const [w, dids] of Object.entries(sealed)) {
            windows.set(w, encodeDigestWindows([sealWindow(Number(w), WIDTH, dids)]))
        }
        return {
            windows,
            deps: {
                snapshot: {
                    getSealedWindow: async (id: string) => windows.get(id) ?? null,
                    getDigestMarker: async () => marker,
                },
                widthMs: WIDTH,
                byteBudget: 1024,
                nowMs: () => nowMs,
            } as unknown as ServeDeps,
        }
    }

    it("serves real entries for windows that were sealed, including empty ones", async () => {
        // Windows are physical entries now, whether or not anything
        // happened in them — this is what lets a gap mean "not yet visible
        // here" rather than "quiet interval", which the next two tests
        // depend on.
        const h = serveHarness(emptyRange(2 * WIDTH, 4 * WIDTH), {
            sealedThrough: 4 * WIDTH,
            oldest: 0,
        })
        const page = await serveDigest(h.deps, 2 * WIDTH)
        expect(page.windows.length).toBe(3)
        for (const w of page.windows) {
            expect(mightHaveChanged(w, DIDS[0])).toBe(false)
        }
    })

    it("stops at a gap rather than synthesizing, and CLAMPS sealedThrough below it", async () => {
        // The property that keeps a lagging KV read replica from being
        // cached as though it were caught up. Windows 90-92 are physically
        // present; 93 onward is not, even though the marker claims
        // coverage through 99 — a real gap, not a genuinely-empty window.
        // Reporting the marker's own sealedThrough here would satisfy
        // handleDigest's `nextCursor <= sealedThrough` "complete" check and
        // cache the lag as the immutable tip.
        const h = serveHarness(emptyRange(90 * WIDTH, 92 * WIDTH), {
            sealedThrough: 99 * WIDTH,
            oldest: 90 * WIDTH,
        })
        const page = await serveDigest(h.deps, 90 * WIDTH)
        expect(page.windows.length).toBe(3)
        expect(page.sealedThrough).toBe(92 * WIDTH)
        expect(page.nextCursor).toBe(93 * WIDTH)
        // The caller reads this as "not complete" and caches briefly, not
        // as the immutable tip — see digest-endpoint.spec.ts for the header.
        expect(page.nextCursor).toBeGreaterThan(page.sealedThrough)
    })

    it("answers an empty, unchanged-cursor page when nothing has EVER sealed", async () => {
        // A fresh deploy, or a wake ahead of the first watchdog tick.
        // Claiming coverage from the wall clock here would be exactly the
        // false claim this function exists to refuse.
        const h = serveHarness({}, null)
        const page = await serveDigest(h.deps, 42 * WIDTH)
        expect(page).toEqual({
            windows: [],
            oldest: 42 * WIDTH,
            sealedThrough: 42 * WIDTH,
            nextCursor: 42 * WIDTH,
        })
    })

    it("carries the floor, the ceiling, and where to resume", async () => {
        const h = serveHarness(emptyRange(3 * WIDTH, 4 * WIDTH), {
            sealedThrough: 4 * WIDTH,
            oldest: 0,
        })
        const page = await serveDigest(h.deps, 3 * WIDTH)
        expect(page.sealedThrough).toBe(4 * WIDTH)
        expect(page.nextCursor).toBe(5 * WIDTH)
        expect(page.oldest).toBe(0)
    })

    it("never serves below the retention floor, so a lost gap stays visible", async () => {
        // Serving from the floor when the cursor predates it would look
        // like coverage. `oldest` is how the client learns it must
        // re-verify instead.
        const h = serveHarness(emptyRange(90 * WIDTH, 99 * WIDTH), {
            sealedThrough: 99 * WIDTH,
            oldest: 90 * WIDTH,
        })
        const page = await serveDigest(h.deps, 0)
        expect(page.oldest).toBe(90 * WIDTH)
        expect(page.windows[0].window).toBe(page.oldest)
        // The client sees its cursor (0) is far below `oldest` and knows
        // to re-verify rather than trusting the gap as "nothing changed".
        expect(page.oldest).toBeGreaterThan(0)
    })

    it("stops at the BYTE budget, not a window count", async () => {
        // The property that makes this survive population growth: fatter
        // windows mean fewer per page, with no constant to re-tune.
        const fat: Record<number, string[]> = {}
        for (let i = 1; i <= 20; i++) {
            fat[i * WIDTH] = Array.from({ length: 400 }, (_, j) => `did:plc:w${i}m${j}`)
        }
        const h = serveHarness(fat, { sealedThrough: 20 * WIDTH, oldest: 0 }, 25 * WIDTH)
        const small = await serveDigest({ ...h.deps, byteBudget: 600 }, WIDTH)
        const large = await serveDigest({ ...h.deps, byteBudget: 6000 }, WIDTH)
        expect(small.windows.length).toBeLessThan(large.windows.length)
        expect(small.nextCursor).toBeLessThan(large.nextCursor)
        // And paging from nextCursor continues where it stopped.
        const second = await serveDigest({ ...h.deps, byteBudget: 600 }, small.nextCursor)
        expect(second.windows[0].window).toBe(small.nextCursor)
    })

    it("signals caught-up by nextCursor passing sealedThrough", async () => {
        // Rather than a truncated flag: one source of truth, nothing to
        // disagree with itself.
        const h = serveHarness({}, { sealedThrough: 4 * WIDTH, oldest: 0 }, 5 * WIDTH)
        const page = await serveDigest(h.deps, 5 * WIDTH)
        expect(page.nextCursor).toBeGreaterThan(page.sealedThrough)
    })
})

describe("the page envelope", () => {
    it("round-trips, carrying the facts the windows cannot", () => {
        const page = {
            windows: [sealWindow(WIDTH, WIDTH, DIDS)],
            oldest: 0,
            sealedThrough: 5 * WIDTH,
            nextCursor: 2 * WIDTH,
        }
        const back = decodeDigestPage(encodeDigestPage(page))
        expect(back.oldest).toBe(0)
        expect(back.sealedThrough).toBe(5 * WIDTH)
        expect(back.nextCursor).toBe(2 * WIDTH)
        expect(back.windows).toHaveLength(1)
        for (const did of DIDS) expect(mightHaveChanged(back.windows[0], did)).toBe(true)
    })
})
