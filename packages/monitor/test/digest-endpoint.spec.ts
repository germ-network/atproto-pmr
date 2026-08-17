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

function endpoint(sealed: Record<number, string[]> = {}, budget = 65_536) {
    const serve = deps(sealed, budget)
    return {
        widthMs: WIDTH,
        nowMs: () => NOW,
        page: (from: number) => serveDigest(serve, from),
    }
}

function deps(sealed: Record<number, string[]> = {}, budget = 65_536): ServeDeps {
    const windows = new Map<string, Uint8Array>()
    for (const [w, dids] of Object.entries(sealed)) {
        windows.set(w, encodeDigestWindows([sealWindow(Number(w), WIDTH, dids)]))
    }
    return {
        index: { readSealedThrough: async () => NOW - WIDTH },
        snapshot: { getSealedWindow: async (id: string) => windows.get(id) ?? null },
        widthMs: WIDTH,
        byteBudget: budget,
        retentionMs: 10 * WIDTH,
        nowMs: () => NOW,
    } as unknown as ServeDeps
}

const get = (query = "") =>
    handleDigest(endpoint(), new Request(`https://monitor.example/digest${query}`))

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
})
