/**
 * `GET /digest?cursor=…` — the unauthenticated change digest.
 *
 * Handlers live here rather than in an adapter for the same reason the
 * relay's do: the response contract is protocol, and an adopter on another
 * platform should inherit it rather than reimplement it.
 */

import { toResponseBody } from "@germ-network/atproto-pmr-core"
import { encodeDigestPage, windowOf, type DigestPage } from "./digest"

/**
 * Cache lifetime for a page that runs to the tip.
 *
 * Capped rather than derived from the window width alone so that a
 * deployment running very wide windows does not pin a stale tip in caches
 * for hours.
 */
const MAX_TIP_CACHE_SECONDS = 300

/**
 * What the endpoint needs, which is deliberately **not** the storage seam.
 *
 * `page` is a producer rather than a `ServeDeps`, so this package's response
 * contract (caching, encoding) stays decoupled from how a page is actually
 * assembled. In the reference deployment that producer is `serveDigest`
 * closed over KV — same process as the handler, no Durable Object in the
 * path at all, which is the point: this signature doesn't know or care.
 */
export interface DigestEndpointDeps {
    /** Window width, for bounding how long a tip page may be cached. */
    widthMs: number
    nowMs(): number
    page(from: number): Promise<DigestPage>
}

export async function handleDigest(
    deps: DigestEndpointDeps,
    request: Request
): Promise<Response> {
    const raw = new URL(request.url).searchParams.get("cursor")
    const parsed = raw === null ? Number.NaN : Number(raw)

    // No cursor is a bootstrap, not an error. A new client has no baseline
    // to diff — it verifies records directly at first contact — so the
    // useful answer is an empty page naming where to start, rather than a
    // history it has no use for.
    const from = Number.isFinite(parsed)
        ? parsed
        : windowOf(deps.nowMs(), deps.widthMs)

    const page = await deps.page(from)

    // A page that stops short of the tip is **immutable**: every window in
    // it is sealed, and the range is fully determined. A page that reaches
    // the tip gains windows as they seal, so it may only be held briefly.
    const complete = page.nextCursor <= page.sealedThrough
    const maxAge = complete
        ? 31_536_000
        : Math.min(MAX_TIP_CACHE_SECONDS, Math.ceil(deps.widthMs / 1000))

    return new Response(toResponseBody(encodeDigestPage(page)), {
        headers: {
            "content-type": "application/cbor",
            "cache-control": `public, max-age=${maxAge}${complete ? ", immutable" : ""}`,
        },
    })
}
