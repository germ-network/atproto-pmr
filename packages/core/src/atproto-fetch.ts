/**
 * Reaching an atproto PDS safely: DID resolution and bounded fetches.
 *
 * Extracted from `declaration.ts` so the key monitor can reuse it. Both
 * callers make **a server-side fetch of an attacker-chosen URL** — the
 * endpoint comes out of the subject's own DID document — so the guards
 * below are the security boundary for every consumer, and duplicating them
 * per package would be exactly the wrong kind of copy.
 *
 * The relay and the monitor share the resolution and diverge after it: a
 * relay reads the declaration as JSON for its own admission check
 * (`declaration.ts`), while a monitor reads CAR, because its output is
 * relayed onward to a device that must verify it.
 */

/**
 * DID -> DID document -> PDS -> declaration, per atproto-pmr.md's own
 * algorithm. `fetchImpl` is injected so tests never make a real network
 * call — every call in this module's test suite is against a fixture.
 *
 * ## This is a server-side fetch of an attacker-chosen URL
 *
 * The PDS endpoint comes out of the *sender's own* DID document, and this
 * runs on an unauthenticated pair put, before any response is sent. That
 * is a server-side request forgery surface, and the fetch is bounded here
 * rather than left to the host:
 *
 *   - **https only.** A DID document naming `file:`, `http:` or anything
 *     else is refused rather than fetched.
 *   - **A timeout**, so a PDS that accepts and never answers cannot pin a
 *     request open.
 *   - **A response cap**, so an endlessly-streaming body cannot exhaust
 *     memory. `response.json()` on an unbounded body is the specific
 *     mistake being avoided.
 *
 * What this deliberately does NOT do is filter private address ranges.
 * That is a resolver-level concern, it is unenforceable from inside
 * `fetch`, and DNS rebinding defeats a naive check anyway. A deployment on
 * a runtime without egress restrictions SHOULD add one — the Workers
 * runtime blocks private-IP fetches, which is why germ's own deployment is
 * covered, but this package is platform-neutral and an adopter on plain
 * Node is not.
 */
/** Bounds on any fetch this module makes. Deliberately conservative. */
const FETCH_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * The endpoint confirmed a terminal state — a caller-recognized signal
 * that this does not exist (or is not currently reachable through this
 * identity), not a transient failure. Raised by two distinct mechanisms
 * (see `guardedFetchBytes`'s `terminalErrorNames` and `guardedFetchJSON`'s
 * `terminalMessagePrefixes`), both structured around the same idea:
 * distinguish "the endpoint is unreachable, retry" from "the endpoint was
 * reached and it confirmed a terminal state" without a caller having to
 * parse an error message itself. The two demand opposite handling: the
 * first should be retried with backoff, and retrying the second forever
 * accomplishes nothing but burning the retry queue on an answer that will
 * not change until something happens again.
 *
 * Deliberately NOT raised from a bare HTTP status code alone — a 404 from
 * an arbitrary https endpoint proves nothing on its own; it could as
 * easily be a misconfigured proxy or a wrong vhost while the real service
 * is merely down. Only a body that actually confirms a recognized
 * terminal state counts.
 *
 * `permanent` separates two shapes of terminal state a caller may need to
 * treat differently: an outcome with no path back short of the subject
 * republishing from scratch (a deleted record, a fully gone repo), versus
 * a reversible state (an account takedown/suspension/deactivation) that
 * may later resolve on its own. A caller that does not need the
 * distinction may treat both alike.
 */
export class RecordNotFoundError extends Error {
    readonly permanent: boolean

    constructor(reason: string, permanent: boolean) {
        super(`confirmed unobtainable: ${reason}`)
        this.name = "RecordNotFoundError"
        this.permanent = permanent
    }
}

/**
 * True for a redirect under `redirect: "manual"`. Two forms, because the
 * runtime decides which one shows up: Cloudflare Workers returns the PDS's
 * actual 3xx status and `Location` header, while the WHATWG fetch spec
 * (browsers, undici) collapses it to an opaque status-0 response with
 * `type: "opaqueredirect"`. Checking status alone misses the second form;
 * checking type alone misses the first.
 *
 * `.type` is read through an `unknown` cast rather than compared against
 * the `ResponseType` literal union directly: Cloudflare's own workers-types
 * narrow that union to exclude `"opaqueredirect"` (a runtime it never
 * itself produces), which makes the literal comparison a TypeScript error
 * for any downstream package — like this one — that also typechecks
 * against workers-types.
 */
function isRedirect(response: Response): boolean {
    if (response.status >= 300 && response.status < 400) return true
    return (response as { type: unknown }).type === "opaqueredirect"
}

/**
 * `fetch` with the bounds above, plus the https-only check.
 *
 * The body is read through a capped reader rather than `response.json()`,
 * because `json()` on an attacker-controlled endpoint will happily buffer
 * until it runs out of memory.
 */
export async function guardedFetchJSON(
    url: string,
    fetchImpl: typeof fetch,
    options: {
        /**
         * Message-prefix strings that mean "confirmed permanently gone",
         * matched against a failing response's `{"message": "..."}` body.
         *
         * **Not the same mechanism as `guardedFetchBytes`'s
         * `terminalErrorNames`.** That one matches an atproto XRPC error
         * body's `error` field exactly, against a lexicon the endpoint
         * itself publishes and commits to. This one exists for services
         * this module also talks to that speak plain REST with free-text
         * messages and no schema commitment at all (the PLC directory) —
         * so it can only ever be a best-effort PREFIX match, never an
         * exact one, against prose one does not control. A caller that
         * omits this gets exactly today's behavior: every non-ok status
         * is the generic error. A prefix that stops matching (the
         * upstream rewords its message) fails CLOSED, back to the
         * generic error and its retry — never toward wrongly confirming
         * a terminal state, since this can only narrow what counts as
         * terminal, never widen it past an actual non-ok response.
         */
        terminalMessagePrefixes?: readonly string[]
    } = {}
): Promise<unknown> {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new Error("malformed endpoint URL")
    }
    if (parsed.protocol !== "https:") {
        throw new Error(`refusing non-https endpoint: ${parsed.protocol}`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await fetchImpl(url, {
            signal: controller.signal,
            // Redirects are REFUSED, not followed — `@atproto/identity` does
            // the same, and without it the https check above is decorative:
            // it validates the URL we chose, and a `302` would take us
            // somewhere it never runs again. That is the whole SSRF hole
            // reopened by a redirect an attacker's PDS controls.
            //
            // "manual", not the spec's "error": Cloudflare Workers' fetch()
            // implements only "follow" and "manual", throwing a TypeError on
            // "error" — a production-only failure, since every test here
            // injects a mock fetchImpl that never validates the option at
            // all. The refusal happens explicitly below instead.
            redirect: "manual",
            headers: { accept: "application/did+ld+json,application/json" },
        })
        if (isRedirect(response)) {
            throw new Error("refusing a redirect")
        }
        if (!response.ok) {
            if (options.terminalMessagePrefixes !== undefined) {
                const message = await tryReadMessageField(response)
                if (
                    message !== null &&
                    options.terminalMessagePrefixes.some((p) => message.startsWith(p))
                ) {
                    // A directory-confirmed terminal state has no path
                    // back short of the subject republishing under a new
                    // identity — always permanent, unlike the reversible
                    // account-lifecycle states `guardedFetchBytes` sees.
                    throw new RecordNotFoundError(message, true)
                }
            }
            throw new Error(`endpoint answered ${response.status}`)
        }
        const text = await readCapped(response, MAX_RESPONSE_BYTES)
        return JSON.parse(text) as unknown
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Best-effort: a small, capped read looking only for a plain REST error
 * body's `{"message": "...", ...}` shape — the PLC directory's shape, not
 * XRPC's. Mirrors `tryReadXrpcErrorName` below exactly, field name aside;
 * see that one for why this duplicates the reader loop rather than
 * sharing it with `readCapped`.
 */
async function tryReadMessageField(response: Response): Promise<string | null> {
    try {
        const text = await readCapped(response, MAX_RESPONSE_BYTES)
        const body = JSON.parse(text) as unknown
        if (typeof body !== "object" || body === null) return null
        const message = (body as Record<string, unknown>).message
        return typeof message === "string" ? message : null
    } catch {
        return null
    }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
    const body = response.body
    if (body === null) return ""
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new Error("response exceeds the maximum size")
        }
        chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        joined.set(c, offset)
        offset += c.byteLength
    }
    return new TextDecoder().decode(joined)
}

/**
 * Best-effort: a small, capped read looking only for XRPC's
 * `{"error": "<Name>", "message": "..."}` error-body shape. Never throws —
 * an unparseable, empty, or oversized body just means "no name available",
 * which the caller falls back to a generic error for. This intentionally
 * duplicates `readCapped`'s reader loop rather than reusing it directly:
 * that one propagates a size-limit exception outward (correct for a
 * successful response, where an oversized body is itself the failure);
 * this one must swallow every failure, because it runs on the already-
 * failing path and an error parsing the *error* body must not replace the
 * real one.
 */
async function tryReadXrpcErrorName(response: Response): Promise<string | null> {
    try {
        const text = await readCapped(response, MAX_RESPONSE_BYTES)
        const body = JSON.parse(text) as unknown
        if (typeof body !== "object" || body === null) return null
        const name = (body as Record<string, unknown>).error
        return typeof name === "string" ? name : null
    } catch {
        return null
    }
}


/**
 * The same guards, returning bytes — for `com.atproto.sync.getRecord`,
 * whose response is CAR rather than JSON.
 *
 * A separate cap because a CAR carries proof blocks as well as the record,
 * so the JSON ceiling would reject legitimate responses.
 */
export async function guardedFetchBytes(
    url: string,
    fetchImpl: typeof fetch,
    options: {
        maxBytes?: number
        /**
         * XRPC `error` field values (from a JSON error body) that mean
         * "confirmed absent, not transient" — raises `RecordNotFoundError`
         * instead of the generic status-code `Error` when the body names
         * one of them. Caller-supplied rather than hardcoded here: which
         * names mean "gone" is a property of the specific XRPC method
         * being called (its own lexicon's `errors` list), which this
         * generic SSRF-guarded fetch has no business knowing on its own.
         * Omit to keep every non-ok response generic, as before.
         */
        terminalErrorNames?: readonly string[]
        /**
         * The subset of `terminalErrorNames` that additionally means
         * "irreversible" — sets `RecordNotFoundError.permanent`. Some
         * terminal states a lexicon defines are lifecycle states with a
         * path back (an account takedown or suspension may lift); only
         * the caller knows which of its own terminal names carry that
         * distinction, so — like `terminalErrorNames` itself — this is
         * supplied, not guessed at here. Omitted, or a name matched in
         * `terminalErrorNames` but absent here, defaults `permanent` to
         * `true`: the safer default when a caller has not opted into the
         * distinction is the one this mechanism shipped with originally,
         * not a silent narrowing of what counts as gone.
         */
        permanentErrorNames?: readonly string[]
    } = {}
): Promise<Uint8Array> {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new Error("malformed endpoint URL")
    }
    if (parsed.protocol !== "https:") {
        throw new Error(`refusing non-https endpoint: ${parsed.protocol}`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await fetchImpl(url, {
            signal: controller.signal,
            // See guardedFetchJSON: "error" throws on Cloudflare Workers.
            redirect: "manual",
            headers: { accept: "application/vnd.ipld.car" },
        })
        if (isRedirect(response)) {
            throw new Error("refusing a redirect")
        }
        if (!response.ok) {
            if (options.terminalErrorNames !== undefined) {
                const name = await tryReadXrpcErrorName(response)
                if (name !== null && options.terminalErrorNames.includes(name)) {
                    const permanent =
                        options.permanentErrorNames === undefined ||
                        options.permanentErrorNames.includes(name)
                    throw new RecordNotFoundError(name, permanent)
                }
            }
            throw new Error(`endpoint answered ${response.status}`)
        }
        return await readCappedBytes(response, options.maxBytes ?? MAX_CAR_BYTES)
    } finally {
        clearTimeout(timer)
    }
}

/** Proof blocks make a CAR larger than the JSON ceiling allows. */
const MAX_CAR_BYTES = 1024 * 1024

async function readCappedBytes(
    response: Response,
    maxBytes: number
): Promise<Uint8Array> {
    const body = response.body
    if (body === null) return new Uint8Array()
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new Error("response exceeds the maximum size")
        }
        chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        joined.set(c, offset)
        offset += c.byteLength
    }
    return joined
}

/**
 * DID -> DID document -> PDS. Supports did:plc (via the PLC directory) and
 * did:web — the two DID methods atproto uses.
 *
 * ## Deliberately a narrow reimplementation of `@atproto/identity`
 *
 * Not an invention: the rules below were read off that package and are
 * meant to match it exactly. It is reimplemented rather than imported
 * because importing costs ~13 MB across 16 packages (zod alone is 5 MB)
 * for what amounts to forty lines — and this package's whole claim is that
 * it carries no platform assumptions and stays light enough for an adopter
 * on any backend.
 *
 * **That trade only holds while this matches.** Every divergence found in
 * review was a bug on our side, and one of them (following redirects) was
 * a security hole. If this drifts, or if a later feature makes
 * `@atproto/crypto` a dependency anyway — CAR verification for observation
 * would — reconsider importing rather than widening this.
 */
/**
 * What resolving a DID document actually yields: where to read the repo,
 * and the authority its content is signed against.
 */
export interface PDSResolution {
    /** The PDS service endpoint — what every caller before this one wanted. */
    endpoint: string
    /**
     * The atproto repo signing key (`verificationMethod`, id `#atproto`,
     * `publicKeyMultibase`), read from the same document fetch. `null` when
     * the document carries none.
     *
     * This is provenance, not a check: nothing here verifies a record
     * against it. It names the authority *this* resolution was made under,
     * for a later reader to compare two observations against — "compare
     * under a common authority, or not at all"
     * (`spec/key-transparency.md`). Verification against it is the
     * client's job, at the client's own resolution time.
     */
    signingKey: string | null
}

/**
 * The PLC directory's own message prefix (`packages/server/src/error.ts`,
 * `did-method-plc`) for a DID whose *last operation is a tombstone* —
 * read directly off the reference server's source and cross-checked
 * against a live 404 from `plc.directory` for a never-registered DID,
 * which answers the sibling prefix "DID not registered: " instead.
 *
 * Deliberately excludes "DID not registered: " — that prefix means no
 * operation was ever recorded for this DID at all, which for a DID this
 * monitor previously resolved successfully is anomalous (a directory-side
 * issue, not a legitimate state change) rather than confirmation of
 * anything, so it stays on the generic/retryable path.
 *
 * This is inherently weaker evidence than `guardedFetchBytes`'s XRPC
 * `error`-field matching: the PLC directory speaks a plain REST error
 * shape with a free-text `message` and no schema commitment at all, so
 * this can only be a prefix match against someone else's prose, not
 * against a published lexicon. See `guardedFetchJSON`'s
 * `terminalMessagePrefixes` doc for why that failure mode is safe: a
 * wording change upstream fails CLOSED, back to the pre-existing
 * generic-retry behavior, never toward wrongly declaring a live DID gone.
 */
const PLC_TOMBSTONE_MESSAGE_PREFIX = "DID not available: "

export async function resolvePDSEndpoint(
    did: string,
    fetchImpl: typeof fetch
): Promise<PDSResolution> {
    let doc: unknown
    if (did.startsWith("did:plc:")) {
        doc = await guardedFetchJSON(
            `https://plc.directory/${encodeURIComponent(did)}`,
            fetchImpl,
            { terminalMessagePrefixes: [PLC_TOMBSTONE_MESSAGE_PREFIX] }
        )
    } else if (did.startsWith("did:web:")) {
        // No terminal detection here, unlike the did:plc branch above: a
        // did:web DID has no directory or operation log to confirm
        // against, only the document host's own HTTP answer — and this
        // module already treats an arbitrary https endpoint's bare 404 as
        // proving nothing (see `RecordNotFoundError`'s own doc comment).
        // A 404 here stays genuinely ambiguous: gone, or the host is
        // merely down.
        doc = await guardedFetchJSON(didWebDocumentURL(did), fetchImpl)
    } else {
        throw new Error(`unsupported DID method: ${did}`)
    }

    // The document must claim the DID we asked for. Cheap, and it closes
    // the case where a directory hands back someone else's document: the
    // endpoint from it would then be used to fetch *this* DID's
    // declaration, and therefore its anchor key, from a host of the
    // wrong party's choosing.
    if (
        typeof doc !== "object" ||
        doc === null ||
        (doc as { id?: unknown }).id !== did
    ) {
        throw new Error("DID document does not match the requested DID")
    }

    const service = extractPDSService(doc as Record<string, unknown>)
    if (service === null) {
        throw new Error("DID document has no #atproto_pds service")
    }
    return {
        endpoint: service,
        signingKey: extractSigningKey(doc as Record<string, unknown>),
    }
}

/**
 * `did:web:example.com` -> `https://example.com/.well-known/did.json`.
 *
 * Two rules that are easy to get wrong, both taken from
 * `@atproto/identity`:
 *
 *   - Each colon-separated part is **percent-decoded**, so
 *     `did:web:example.com%3A3000` resolves to host `example.com:3000`
 *     rather than a nonsense hostname containing a literal `%3A`.
 *   - A **path-form** did:web (more than one part) is REFUSED. The did:web
 *     method would put that document at `/user/alice/did.json`, not under
 *     `/.well-known/`, and atproto does not support the form at all.
 *     Guessing either way means fetching the wrong URL, so this refuses
 *     rather than resolve a DID differently from the rest of the network.
 */
function didWebDocumentURL(did: string): string {
    const parts = did.slice("did:web:".length).split(":").map(decodeURIComponent)
    if (parts.length !== 1 || parts[0].length === 0) {
        throw new Error(`unsupported did:web form: ${did}`)
    }
    return `https://${parts[0]}/.well-known/did.json`
}

/**
 * The PDS service entry, selected **by id first** — `#atproto_pds`, either
 * bare or absolute (`did:plc:xyz#atproto_pds`) — and only then confirmed by
 * type.
 *
 * Matching on type alone, as an earlier version did, is an interop bug with
 * teeth: a document whose `#atproto_pds` entry and its
 * `AtprotoPersonalDataServer`-typed entry disagree would resolve to a
 * different host here than in every other atproto implementation. Since the
 * declaration — and so the anchor key — is fetched from whatever this
 * returns, disagreeing about the endpoint is disagreeing about identity.
 */
function extractPDSService(doc: Record<string, unknown>): string | null {
    const services = doc.service
    if (!Array.isArray(services)) return null

    const docId = typeof doc.id === "string" ? doc.id : ""
    for (const entry of services) {
        if (typeof entry !== "object" || entry === null) continue
        const { id, type, serviceEndpoint } = entry as {
            id?: unknown
            type?: unknown
            serviceEndpoint?: unknown
        }
        if (typeof id !== "string") continue
        if (id !== "#atproto_pds" && id !== `${docId}#atproto_pds`) continue
        if (type !== "AtprotoPersonalDataServer") return null
        if (typeof serviceEndpoint !== "string") return null
        // The endpoint is attacker-supplied; `guardedFetchJSON` re-checks
        // the scheme on the URL actually fetched, but rejecting a
        // non-http(s) endpoint here keeps the failure legible.
        if (
            !serviceEndpoint.startsWith("https://") &&
            !serviceEndpoint.startsWith("http://")
        ) {
            return null
        }
        return serviceEndpoint
    }
    return null
}

/**
 * The atproto repo signing key: `verificationMethod`, selected **by id
 * only** — `#atproto`, either bare or absolute — matching
 * `@atproto/common-web`'s `getVerificationMaterial`/`findItemById`
 * exactly, id form included.
 *
 * Deliberately **not** filtered by `type`, unlike `extractPDSService`'s
 * service-type check. That is not an inconsistency: it is what the
 * reference does too (`getVerificationMaterial` returns `{type,
 * publicKeyMultibase}` unfiltered; only its caller,
 * `getDidKeyFromMultibase`, branches on `type` to know how to parse the
 * bytes cryptographically). This module never parses the bytes — the
 * value is provenance, compared as an opaque string in
 * `compareObservations` — so there is nothing here for a type filter to
 * protect, and one would only diverge from what the rest of the network
 * resolves for documents still carrying a pre-`Multikey` type
 * (`EcdsaSecp256k1VerificationKey2019` etc., which the reference still
 * reads).
 *
 * Returns `null` rather than throwing when absent. Unlike a missing PDS
 * service, a missing signing key does not block the fetch this module
 * exists to make — a monitor still serves what it read, and an atproto
 * client is what fails a record against no key, not this resolver.
 */
function extractSigningKey(doc: Record<string, unknown>): string | null {
    const methods = doc.verificationMethod
    if (!Array.isArray(methods)) return null

    const docId = typeof doc.id === "string" ? doc.id : ""
    for (const entry of methods) {
        if (typeof entry !== "object" || entry === null) continue
        const { id, publicKeyMultibase } = entry as {
            id?: unknown
            publicKeyMultibase?: unknown
        }
        if (typeof id !== "string") continue
        if (id !== "#atproto" && id !== `${docId}#atproto`) continue
        if (typeof publicKeyMultibase !== "string") return null
        return publicKeyMultibase
    }
    return null
}
