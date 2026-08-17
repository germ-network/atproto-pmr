/**
 * The digest endpoint.
 *
 * What is worth pinning here is the caching, because it is where a correct
 * page can still be served wrongly: a page that reaches the tip gains
 * windows as they seal, so holding it is serving stale coverage — and
 * stale coverage on this surface reads as "nothing changed".
 */
import { describe, expect, it } from "vitest"
import { handleDigest } from "../src/digest-endpoint"
import {
    decodeDigestPage,
    encodeDigestWindows,
    sealWindow,
    serveDigest,
    windowOf,
    type ServeDeps,
} from "../src/digest"

const WIDTH = 600_000
const NOW = 100 * WIDTH

/** Every physical window entry in `[fromWindow, toWindowInclusive]`, empty. */
function emptyRange(fromWindow: number, toWindowInclusive: number): Record<number, string[]> {
    const out: Record<number, string[]> = {}
    for (let w = fromWindow; w <= toWindowInclusive; w += WIDTH) out[w] = []
    return out
}

/**
 * `sealed: null` (the default) means "fully propagated" — every window the
 * marker claims is physically present, empty or not, which is the ordinary
 * case in production and what most of these tests want. Pass an explicit
 * (necessarily partial) map to test a real gap instead.
 */
function endpoint(sealed: Record<number, string[]> | null = null, budget = 65_536) {
    const serve = deps(sealed, budget)
    return {
        widthMs: WIDTH,
        nowMs: () => NOW,
        page: (from: number) => serveDigest(serve, from),
    }
}

function deps(sealed: Record<number, string[]> | null = null, budget = 65_536): ServeDeps {
    const windows = new Map<string, Uint8Array>()
    const entries = sealed ?? emptyRange(90 * WIDTH, 99 * WIDTH)
    for (const [w, dids] of Object.entries(entries)) {
        windows.set(w, encodeDigestWindows([sealWindow(Number(w), WIDTH, dids)]))
    }
    return {
        snapshot: {
            getSealedWindow: async (id: string) => windows.get(id) ?? null,
            getDigestMarker: async () => ({ sealedThrough: NOW - WIDTH, oldest: NOW - 10 * WIDTH }),
        },
        widthMs: WIDTH,
        byteBudget: budget,
        nowMs: () => NOW,
    } as unknown as ServeDeps
}

const get = (query = "") =>
    handleDigest(endpoint(), new Request(`https://monitor.example/digest${query}`))

/** No digest has ever sealed — a fresh deploy, or a wake ahead of the first watchdog tick. */
function endpointWithNoMarker() {
    return {
        widthMs: WIDTH,
        nowMs: () => NOW,
        page: (from: number) =>
            serveDigest(
                {
                    snapshot: {
                        getSealedWindow: async () => null,
                        getDigestMarker: async () => null,
                    },
                    widthMs: WIDTH,
                    byteBudget: 65_536,
                    nowMs: () => NOW,
                } as unknown as ServeDeps,
                from
            ),
    }
}

describe("handleDigest", () => {
    it("answers CBOR, unauthenticated", async () => {
        const response = await get(`?cursor=${95 * WIDTH}`)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe("application/cbor")
        const page = decodeDigestPage(new Uint8Array(await response.arrayBuffer()))
        expect(page.sealedThrough).toBe(NOW - WIDTH)
    })

    it("treats a missing cursor as a bootstrap, not an error", async () => {
        // A new client has no baseline to diff — it verifies records
        // directly at first contact — so the useful answer is where to
        // start, not a history it cannot use.
        const response = await get()
        expect(response.status).toBe(200)
        const page = decodeDigestPage(new Uint8Array(await response.arrayBuffer()))
        expect(page.windows).toHaveLength(0)
        expect(page.nextCursor).toBe(windowOf(NOW, WIDTH))
    })

    it("does the same with a malformed cursor rather than failing", async () => {
        const page = decodeDigestPage(
            new Uint8Array(await (await get("?cursor=banana")).arrayBuffer())
        )
        expect(page.nextCursor).toBe(windowOf(NOW, WIDTH))
    })

    it("caches a tip page only briefly — it gains windows as they seal", async () => {
        // Holding this one longer serves stale coverage, and stale
        // coverage on this surface reads as "nothing changed".
        const response = await get(`?cursor=${95 * WIDTH}`)
        const cc = response.headers.get("cache-control") ?? ""
        expect(cc).toContain("public")
        expect(cc).not.toContain("immutable")
        const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1])
        expect(maxAge).toBeLessThanOrEqual(600)
    })

    it("caches a truncated page as immutable — it is fully determined", async () => {
        // Every window in it is sealed and the range cannot grow, so this
        // is the page worth caching hard.
        const fat: Record<number, string[]> = {}
        for (let i = 91; i < 99; i++) {
            fat[i * WIDTH] = Array.from({ length: 400 }, (_, j) => `did:plc:w${i}m${j}`)
        }
        const response = await handleDigest(
            endpoint(fat, 600),
            new Request(`https://monitor.example/digest?cursor=${91 * WIDTH}`)
        )
        const cc = response.headers.get("cache-control") ?? ""
        expect(cc).toContain("immutable")
        const page = decodeDigestPage(new Uint8Array(await response.arrayBuffer()))
        expect(page.nextCursor).toBeLessThanOrEqual(page.sealedThrough)
    })

    it("carries the retention floor, so a lost gap is visible", async () => {
        const page = decodeDigestPage(
            new Uint8Array(await (await get("?cursor=0")).arrayBuffer())
        )
        expect(page.oldest).toBe(90 * WIDTH)
        expect(page.windows[0].window).toBe(page.oldest)
    })

    it("does NOT cache as immutable when the page stopped at a REPLICATION GAP, not the true tip", async () => {
        // The property the DO-read-offload could get wrong: a page a KV
        // read replica truncated because a window has not propagated yet
        // must not be cacheable the same way a genuinely complete page is
        // — that would pin the lag as though it were the caught-up answer.
        // Windows 91-92 are physically present; 93 onward is not, even
        // though the marker (see `deps`) claims coverage through 99.
        const response = await handleDigest(
            endpoint({ [91 * WIDTH]: [], [92 * WIDTH]: [] }),
            new Request(`https://monitor.example/digest?cursor=${91 * WIDTH}`)
        )
        const cc = response.headers.get("cache-control") ?? ""
        expect(cc).not.toContain("immutable")
        const page = decodeDigestPage(new Uint8Array(await response.arrayBuffer()))
        // Clamped to what was actually confirmed, not the marker's 99*WIDTH.
        expect(page.sealedThrough).toBe(92 * WIDTH)
        expect(page.nextCursor).toBeGreaterThan(page.sealedThrough)
    })

    it("does NOT cache as immutable when no digest has EVER sealed", async () => {
        // A fresh deploy answers with sealedThrough clamped below
        // nextCursor (see serveDigest's null-marker branch) precisely so
        // this doesn't happen: reporting them equal would satisfy
        // handleDigest's own "complete" check and pin an empty, unchanged
        // cursor as the immutable tip for a year, wedging every caller
        // that respects the header behind a stale bootstrap forever.
        const response = await handleDigest(
            endpointWithNoMarker(),
            new Request(`https://monitor.example/digest?cursor=${42 * WIDTH}`)
        )
        const cc = response.headers.get("cache-control") ?? ""
        expect(cc).not.toContain("immutable")
        const page = decodeDigestPage(new Uint8Array(await response.arrayBuffer()))
        expect(page.windows).toHaveLength(0)
        expect(page.nextCursor).toBe(42 * WIDTH)
        expect(page.nextCursor).toBeGreaterThan(page.sealedThrough)
    })
})
