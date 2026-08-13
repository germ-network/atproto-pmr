/**
 * Wraps a handler so a thrown error becomes a 500 rather than an unhandled
 * rejection.
 *
 * A 500 here IS reachable on a peer-facing put — e.g. a KV or DO binding
 * failure partway through handlePairPut — and that is fine, not a closure
 * violation: infrastructure failures fire independent of any recipient-side
 * state (blocked, full, discarded), so a 500's mere existence discloses
 * nothing about the recipient. What actually must never happen is a
 * DISTINGUISHABLE answer correlated with recipient state on the paths this
 * wraps — that discipline lives in pair-put.ts's own branches (see its
 * module doc), not here. This wrapper's only job is to keep an unexpected
 * throw from becoming an unhandled rejection.
 */
export async function runWithErrorHandling(
    handler: () => Promise<Response>
): Promise<Response> {
    try {
        return await handler()
    } catch (e) {
        console.log("request failed", e)
        return new Response("Internal error", { status: 500 })
    }
}

export function binaryToBase64URL(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

export function base64URLToBinary(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

/**
 * Reads a request body, refusing anything over `maxBytes` without buffering
 * the excess.
 */
export async function readBodyCapped(
    request: Request,
    maxBytes: number
): Promise<Uint8Array> {
    const body = request.body
    if (body === null) {
        return new Uint8Array(0)
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new Error("Body exceeds maximum size")
        }
        chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

/**
 * Copy bytes into a standalone `ArrayBuffer` for use as a response body.
 *
 * A `Uint8Array` may be a view onto a larger buffer, so handing its
 * `.buffer` to `Response` would send the whole backing store — silently, and
 * only when the view happens to be a subarray. Copying is one allocation on
 * payloads that are already bounded, and removes the class of bug.
 */
export function toResponseBody(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(out).set(bytes)
    return out
}
