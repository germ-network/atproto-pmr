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
 */
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
        const response = await fetchImpl(url.toString())
        if (!response.ok) {
            return {
                found: false,
                reason: `declaration fetch: PDS answered ${response.status}`,
            }
        }
        const body = (await response.json()) as { value?: unknown }
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
 * did:web (document at the well-known path) — the two DID methods atproto
 * uses.
 */
async function resolvePDSEndpoint(
    did: string,
    fetchImpl: typeof fetch
): Promise<string> {
    let doc: unknown
    if (did.startsWith("did:plc:")) {
        const response = await fetchImpl(`https://plc.directory/${did}`)
        if (!response.ok) {
            throw new Error(`PLC directory answered ${response.status}`)
        }
        doc = await response.json()
    } else if (did.startsWith("did:web:")) {
        const hostname = did.slice("did:web:".length).replace(/:/g, "/")
        const response = await fetchImpl(
            `https://${hostname}/.well-known/did.json`
        )
        if (!response.ok) {
            throw new Error(`did:web document answered ${response.status}`)
        }
        doc = await response.json()
    } else {
        throw new Error(`unsupported DID method: ${did}`)
    }

    const service = extractPDSService(doc)
    if (service === null) {
        throw new Error("DID document has no AtprotoPersonalDataServer service")
    }
    return service
}

function extractPDSService(doc: unknown): string | null {
    if (typeof doc !== "object" || doc === null || !("service" in doc)) {
        return null
    }
    const services = (doc as { service?: unknown }).service
    if (!Array.isArray(services)) return null
    for (const entry of services) {
        if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: unknown }).type ===
                "AtprotoPersonalDataServer" &&
            typeof (entry as { serviceEndpoint?: unknown }).serviceEndpoint ===
                "string"
        ) {
            return (entry as { serviceEndpoint: string }).serviceEndpoint
        }
    }
    return null
}
