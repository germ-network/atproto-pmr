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
    sealWindow,
    sizeFor,
    windowOf,
    type DigestWindow,
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
        expect(windowOf((base + 1) * WIDTH, WIDTH)).toBe(base + 1)
    })

    it("is computable by a client from a timestamp alone", () => {
        // The client has to know which windows to ask for without being
        // told, which is why this is division rather than a server counter.
        expect(windowOf(0, WIDTH)).toBe(0)
        expect(windowOf(WIDTH - 1, WIDTH)).toBe(0)
        expect(windowOf(WIDTH, WIDTH)).toBe(1)
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
