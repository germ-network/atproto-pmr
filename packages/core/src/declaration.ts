import { OkpEd25519Key, encodeOkpEd25519Key, parseOkpEd25519Key } from "./cose/key"

/**
 * Resolves a sender DID to its declared anchor key, for pair-put sender
 * authentication.
 *
 * DIRECT FETCH, NOT CAR — this is the relay's own admission check, not
 * content the relay hands onward to a device. Two independent documents
 * agree on the algorithm, and neither mentions CAR for this specific step:
 *
 *   - atproto-pmr.md §Sender authentication states the algorithm directly:
 *     "Look up the sender's declaration... On a miss, resolve it: sender DID
 *     -> DID document -> PDS -> declaration." No CAR.
 *   - the specification's framing of the CAR requirement is "how does a DEVICE trust a
 *     record A RELAY HANDS IT" — content the relay relays onward. This
 *     module's output never leaves the relay; it is consumed by
 *     verifyPairPut and then discarded.
 *
 * wire-api.md's verification-algorithm section says "CAR-verified" for step
 * 2, but that phrasing describes the DEVICE's algorithm (the one thing a
 * relay-delivered record needs, because provenance is exactly what relay
 * delivery discards). Applying it to the relay's OWN direct-to-PDS fetch
 * conflates two different trust boundaries — TLS-to-the-authoritative-PDS is
 * not "a relay hands it to you." See the implementation plan for the full
 * reasoning; this comment is the load-bearing summary.
 *
 * This is also the only implementable choice today: no CAR/DAG-CBOR/MST
 * library exists anywhere in this repo, and storage-protocol.md frames
 * relay-side CAR parsing as "defense in depth against a lying PDS, added
 * deliberately rather than assumed" — future hardening, not a v1
 * prerequisite (the relay needs signature verification, not a CAR parser).
 *
 * TODO(CAR): add CAR verification of the fetched declaration as defense in
 * depth against a PDS that lies to this relay specifically (distinct from a
 * relay lying to a device, which the CAR requirement already covers). Not required for
 * correctness of THIS relay's own admission decision, which trusts the PDS
 * it is directly, authoritatively talking to over TLS — the same trust basis
 * the client uses today before any relay exists (trust-model.md: "authority
 * comes from provenance: DID -> DID document -> PDS -> the record... over
 * TLS").
 *
 * NO CACHE. A direct fetch runs on every pair put, deliberately: caching is
 * the observation feature's job (storage-protocol.md's observation cache,
 * "deliberately the weakest tier"), which is not built yet, and a
 * half-built cache here would be scope creep ahead of that feature existing.
 * Costing the same fetch on every call also keeps this symmetric across
 * outcomes — nothing about caching can become a timing signal.
 */

export type DeclarationResolution =
    | { found: true; anchorKey: OkpEd25519Key }
    | { found: false; reason: string }

/**
 * The germ declaration's anchor-key field: NOT COSE. One field —
 * an algorithm identifier byte followed by the raw key bytes — because this
 * is the frozen, published record format existing clients already parse
 * (spec/wire-api.md, "Key material"). Converted to `COSE_Key`-equivalent
 * shape on ingest, here, so nothing downstream of this function handles two
 * formats.
 *
 * The format is one algorithm-identifier byte followed by the raw key
 * bytes, with no length prefix and no enclosing structure. The identifiers
 * are assigned in this order:
 *
 *     0  ChaCha20Poly1305
 *     1  Curve25519 key agreement  (X25519)
 *     2  Curve25519 signing        (Ed25519)
 *     3  HPKE encapsulation
 *
 * The anchor key is a **signing** key, so byte **2** — not 1. Byte 1 is
 * key *agreement*, a different key entirely, and reading the wrong one
 * would silently accept or reject the wrong field. Byte 2 is the only case
 * this relay accepts today, per the PQ posture: launch classical,
 * algorithm-agile.
 */
const ANCHOR_KEY_ALG_CURVE25519_SIGNING = 2

/**
 * The declaration record's collection NSID. A protocol constant rather
 * than a deployment tunable, so it lives in code rather than in the
 * caller-supplied `PMRConfig`.
 */
const DECLARATION_COLLECTION_NSID = "com.germnetwork.declaration"

/**
 * Atproto's JSON data-model bytes representation: `{"$bytes": "<base64>"}`,
 * standard alphabet (not base64url), and **unpadded** — the data model's
 * canonical form omits padding. `atob` requires padding, so it is restored
 * before decoding rather than assumed present.
 *
 * `response.json()` never produces a `Uint8Array` — JSON has no binary
 * type — so this is required, not optional, for any field read out of an
 * XRPC JSON response. An `instanceof Uint8Array` check here would silently
 * never match a real response.
 */
function decodeAtprotoBytes(value: unknown): Uint8Array {
    if (typeof value !== "object" || value === null || !("$bytes" in value)) {
        throw new Error('expected an atproto bytes object ({"$bytes": ...})')
    }
    const b64 = (value as { $bytes: unknown })["$bytes"]
    if (typeof b64 !== "string") {
        throw new Error("$bytes value must be a string")
    }
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

function parseFrozenAnchorKeyField(bytes: Uint8Array): OkpEd25519Key {
    if (bytes.byteLength !== 33) {
        throw new Error(
            "declaration: currentKey field must be 33 bytes (1 alg byte + 32 key bytes)"
        )
    }
    if (bytes[0] !== ANCHOR_KEY_ALG_CURVE25519_SIGNING) {
        throw new Error(
            `declaration: unsupported currentKey algorithm byte ${bytes[0]}`
        )
    }
    return { x: bytes.subarray(1) }
}

/**
 * The declaration record as this relay reads it. The anchor key field is
 * `currentKey` — note, not `anchorKey`. Every other field the record
 * carries is opaque to a relay and deliberately not modeled here.
 */
interface RawDeclarationRecord {
    currentKey?: unknown
}

function isRawDeclarationRecord(value: unknown): value is RawDeclarationRecord {
    return typeof value === "object" && value !== null
}

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
 * `fetch` with the bounds above, plus the https-only check.
 *
 * The body is read through a capped reader rather than `response.json()`,
 * because `json()` on an attacker-controlled endpoint will happily buffer
 * until it runs out of memory.
 */
async function guardedFetchJSON(
    url: string,
    fetchImpl: typeof fetch
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
            redirect: "error",
            headers: { accept: "application/did+ld+json,application/json" },
        })
        if (!response.ok) {
            throw new Error(`endpoint answered ${response.status}`)
        }
        const text = await readCapped(response, MAX_RESPONSE_BYTES)
        return JSON.parse(text) as unknown
    } finally {
        clearTimeout(timer)
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

export async function resolveDeclaration(
    senderDID: string,
    fetchImpl: typeof fetch = fetch
): Promise<DeclarationResolution> {
    let pdsEndpoint: string
    try {
        pdsEndpoint = await resolvePDSEndpoint(senderDID, fetchImpl)
    } catch (e) {
        return { found: false, reason: `PDS resolution failed: ${String(e)}` }
    }

    let record: unknown
    try {
        const url = new URL(`${pdsEndpoint}/xrpc/com.atproto.repo.getRecord`)
        url.searchParams.set("repo", senderDID)
        url.searchParams.set("collection", DECLARATION_COLLECTION_NSID)
        url.searchParams.set("rkey", "self")
        const body = (await guardedFetchJSON(url.toString(), fetchImpl)) as {
            value?: unknown
        }
        record = body.value
    } catch (e) {
        return { found: false, reason: `declaration fetch failed: ${String(e)}` }
    }

    if (!isRawDeclarationRecord(record) || record.currentKey === undefined) {
        return { found: false, reason: "declaration: no currentKey present" }
    }

    try {
        const rawBytes = decodeAtprotoBytes(record.currentKey)
        // The one conversion point: the declaration's frozen key field ->
        // the shape verifyPairPut consumes. Round-tripping through
        // encode/parse means this function's output always satisfies the
        // exact same invariants a COSE_Key parsed from the wire would —
        // nothing downstream ever has to know this key came from a
        // different format.
        const frozen = parseFrozenAnchorKeyField(rawBytes)
        return {
            found: true,
            anchorKey: parseOkpEd25519Key(encodeOkpEd25519Key(frozen)),
        }
    } catch (e) {
        return {
            found: false,
            reason: `declaration: malformed currentKey: ${String(e)}`,
        }
    }
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
async function resolvePDSEndpoint(
    did: string,
    fetchImpl: typeof fetch
): Promise<string> {
    let doc: unknown
    if (did.startsWith("did:plc:")) {
        doc = await guardedFetchJSON(
            `https://plc.directory/${encodeURIComponent(did)}`,
            fetchImpl
        )
    } else if (did.startsWith("did:web:")) {
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
    return service
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
