/**
 * RFC 8030 delivery of a sealed Web Push message to a subscription's
 * capability-URL endpoint.
 *
 * The endpoint is a URL the DEVICE minted at its own push service and
 * handed to this relay — not attacker-chosen the way a DID document's PDS
 * endpoint is (`atproto-fetch.ts`), but still an outbound fetch to a URL
 * this code did not construct, so the same https-only / no-redirect /
 * timeout discipline applies. See `atproto-fetch.ts`'s `isRedirect` for why
 * both response shapes are checked.
 */

const FETCH_TIMEOUT_MS = 10_000
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

function isRedirect(response: Response): boolean {
    if (response.status >= 300 && response.status < 400) return true
    return (response as { type: unknown }).type === "opaqueredirect"
}

export type DeliverPushResult =
    /** 2xx — the push service accepted it. */
    | { outcome: "delivered" }
    /**
     * 404 or 410 — RFC 8030's normative discard signal. The CALLER performs
     * the deletion; this module is transport, not storage.
     */
    | { outcome: "discard" }
    /** 429 — respect `Retry-After`. There is no retry queue on this path
     * (the entry stays queued in its mailbox regardless, and the next
     * arrival or drain recovers it); callers observe this and drop it. */
    | { outcome: "retry"; retryAfterSeconds: number | null }
    /**
     * Anything else, including 401 (unrecognized/unauthorized — NOT treated
     * as `discard`: some push services, including germ-service, answer 401
     * both for a genuinely unknown subscription and, indistinguishably, for
     * a deployment-side VAPID misconfiguration or key rotation. A single
     * 401 is not evidence the subscription is dead; the caller's own
     * persistent-failure policy decides when enough is enough.)
     */
    | { outcome: "failed"; status: number }

export interface DeliverPushOptions {
    fetchImpl: typeof fetch
    authorizationHeader: string
    ttlSeconds: number
    topic?: string
    urgency?: "very-low" | "low" | "normal" | "high"
}

export async function deliverPush(
    endpoint: string,
    sealed: Uint8Array,
    opts: DeliverPushOptions
): Promise<DeliverPushResult> {
    let parsed: URL
    try {
        parsed = new URL(endpoint)
    } catch {
        throw new Error("malformed subscription endpoint")
    }
    if (parsed.protocol !== "https:") {
        throw new Error(`refusing non-https endpoint: ${parsed.protocol}`)
    }
    if (opts.topic !== undefined && !TOPIC_PATTERN.test(opts.topic)) {
        throw new Error(
            "Topic must be 1-32 chars of [A-Za-z0-9_-] " +
                "(refused locally rather than left for the push service to 400)"
        )
    }

    const headers: Record<string, string> = {
        // Not RFC 8188's `aes128gcm` Content-Encoding scheme — this is the
        // symmetric, relay-delegated format `spec/wire-api.md` defines, so
        // no Content-Encoding header is sent; the media type alone
        // identifies it.
        "Content-Type": "application/webpush-message",
        Authorization: opts.authorizationHeader,
        TTL: String(opts.ttlSeconds),
    }
    if (opts.topic !== undefined) headers.Topic = opts.topic
    if (opts.urgency !== undefined) headers.Urgency = opts.urgency

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await opts.fetchImpl(endpoint, {
            method: "POST",
            headers,
            // `lib.dom.d.ts`'s `BodyInit` wants `ArrayBufferView<ArrayBuffer>`
            // specifically, not the broader `ArrayBufferLike` a plain
            // `Uint8Array` carries under TS 5.7+'s generic typed arrays — a
            // known lib-typing gap, not a real mismatch; any `Uint8Array` is
            // a valid fetch body at runtime, in Workers, Node, and browsers.
            body: sealed as BodyInit,
            signal: controller.signal,
            // See atproto-fetch.ts: "manual", not the spec's "error" — the
            // Workers runtime throws a TypeError on "error".
            redirect: "manual",
        })
        if (isRedirect(response)) {
            return { outcome: "failed", status: response.status }
        }
        if (response.status === 404 || response.status === 410) {
            return { outcome: "discard" }
        }
        if (response.status === 429) {
            const header = response.headers.get("Retry-After")
            const seconds = header === null ? NaN : Number(header)
            return {
                outcome: "retry",
                retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
            }
        }
        if (response.ok) {
            return { outcome: "delivered" }
        }
        return { outcome: "failed", status: response.status }
    } finally {
        clearTimeout(timer)
    }
}
