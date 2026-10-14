/**
 * Cached DID documents (`spec/proxy-cache.md`, "The model"). The signing key
 * and PDS endpoint are read from the cached document instead of a fresh
 * directory fetch.
 */

import { extractSigningKey, SIGNING_KEY_TTL_MS } from "./atproto-fetch"

/**
 * The parts of a DID document this protocol reads. Other members a directory
 * returns are kept on the object but not typed.
 */
export interface DidDocument {
    id: string
    alsoKnownAs?: string[]
    verificationMethod?: DidVerificationMethod[]
    service?: DidService[]
}

export interface DidVerificationMethod {
    id: string
    type: string
    controller: string
    publicKeyMultibase?: string
}

export interface DidService {
    id: string
    type: string
    /** A URL string for `#atproto_pds`; DID Core also allows a map or a set. */
    serviceEndpoint: unknown
}

/**
 * Where the document came from. `plc` documents follow the PLC export stream;
 * `web` documents can only be re-fetched from their host, so they are
 * refreshed on age.
 */
export type DidDocumentSource = "plc" | "web"

export interface CachedDidDocument {
    doc: DidDocument
    fetchedAtMs: number
    source: DidDocumentSource
}

export interface DidDocumentCache {
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    get(did: string): Promise<CachedDidDocument | null>
}

// ---- The monitor-kept cache: rendering, trust, and stream coverage ---------
//
// A key monitor keeps a `CachedDidDocument` per watched DID, written from a
// `did:plc` operation on the PLC directory's export stream (rendered from the
// operation) and from every DID-document fetch it already makes when it reads
// or re-checks a record (which also covers `did:web`). `fetchedAtMs` is when
// the monitor last confirmed the document current, by either path. A DID the
// monitor cannot vouch for — tombstoned, or changed in a way it could not
// render — is simply absent, so the reader asks the directory.
//
// How long a reader trusts a cached document depends on whether a change
// after its confirmation would have reached the cache: only a `plc` document
// confirmed inside the export stream's current unbroken run, with the stream
// caught up, is trusted for STORED_DID_DOCUMENT_MAX_AGE_MS. Anything else is
// trusted for the same ten minutes a direct fetch is cached.

/** The longest a cached document is trusted, and only while the stream covers it. */
export const STORED_DID_DOCUMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** How far behind real time the export stream may be and still count as covering. */
export const PLC_COVERAGE_MAX_LAG_MS = 10 * 60 * 1000

/**
 * What the monitor's consumption of the PLC export stream vouches for:
 * every operation accepted by the directory from `continuousSinceMs` through
 * `coveredThroughMs` (directory `createdAt` times) has reached the cached
 * documents readers see.
 */
export interface PlcCoverage {
    /** The export stream consumed, informational: `seq` is per directory host. */
    url: string
    /** Start of the current unbroken run; a restart without a usable cursor resets it. */
    continuousSinceMs: number
    coveredThroughMs: number
}

/**
 * The DID document the PLC directory serves for an operation's state, per the
 * did:plc spec's "Presentation as DID Document": `verificationMethods` become
 * `Multikey` entries (`publicKeyMultibase` = the did:key value without its
 * `did:key:` prefix), `services` become `service` entries (`#<name>`,
 * `serviceEndpoint`), `alsoKnownAs` is carried over, and `rotationKeys` are
 * omitted.
 *
 * Where the live directory departs from the spec's example, this follows the
 * directory: a verification method's id is the absolute `<did>#<name>`, and
 * the third `@context` entry is chosen by key family (P-256 `zDna…` →
 * ecdsa-2019, secp256k1 `zQ3s…` → secp256k1-2019). Keys are emitted in the
 * directory's order.
 *
 * `op` is the `operation` of a `sequenced_op` export entry. Returns `null`
 * unless it is a well-formed current-format `plc_operation` of a shape a live
 * document has been checked against; the caller then refetches from the
 * directory rather than rendering a guess.
 */
export function renderPlcDocument(did: string, op: unknown): DidDocument | null {
    if (!isRecord(op) || op.type !== "plc_operation") return null

    const methods = entriesOf(op.verificationMethods)
    const services = entriesOf(op.services)
    const aliases = op.alsoKnownAs
    if (methods?.length !== 1 || services?.length !== 1) return null
    if (!Array.isArray(aliases) || aliases.length === 0) return null
    if (!aliases.every((alias) => typeof alias === "string")) return null

    const [name, didKey] = methods[0]!
    if (typeof didKey !== "string" || !didKey.startsWith(DID_KEY_PREFIX)) return null
    const publicKeyMultibase = didKey.slice(DID_KEY_PREFIX.length)
    const suite = KEY_FAMILY_SUITES.find(([prefix]) => publicKeyMultibase.startsWith(prefix))
    if (!suite) return null

    const service: DidService[] = []
    for (const [serviceName, value] of services) {
        if (!isRecord(value)) return null
        if (typeof value.type !== "string" || typeof value.endpoint !== "string") return null
        service.push({
            id: `#${serviceName}`,
            type: value.type,
            serviceEndpoint: value.endpoint,
        })
    }

    const document: DidDocument & { "@context": string[] } = {
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/multikey/v1",
            suite[1],
        ],
        id: did,
        alsoKnownAs: [...(aliases as string[])],
        verificationMethod: [
            {
                id: `${did}#${name}`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase,
            },
        ],
        service,
    }
    return document
}

const DID_KEY_PREFIX = "did:key:"

/** The third `@context` entry the directory serves for each key family it has been seen to serve. */
const KEY_FAMILY_SUITES: readonly (readonly [string, string])[] = [
    ["zDna", "https://w3id.org/security/suites/ecdsa-2019/v1"],
    ["zQ3s", "https://w3id.org/security/suites/secp256k1-2019/v1"],
]

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entriesOf(value: unknown): [string, unknown][] | null {
    return isRecord(value) ? Object.entries(value) : null
}

export interface StoredSigningKeyResolverDeps {
    /** The monitor's cache. A throw is treated as a miss. */
    documents: DidDocumentCache
    /** The monitor's published stream coverage. A throw or null means uncovered. */
    getPlcCoverage(): Promise<PlcCoverage | null>
    /** Used when there is no cached document trusted now. */
    fallback(did: string): Promise<string | null>
    nowMs(): number
}

/**
 * The `#atproto` signing key from the cached DID document while it is
 * trusted; otherwise `fallback` (in practice `cachedSigningKeyResolver`)
 * answers. Never contacts a PDS.
 *
 * Trusted for {@link STORED_DID_DOCUMENT_MAX_AGE_MS} when `source` is `plc`,
 * `fetchedAtMs >= continuousSinceMs`, and the coverage is within
 * {@link PLC_COVERAGE_MAX_LAG_MS} of now; otherwise for `SIGNING_KEY_TTL_MS`.
 */
export function storedSigningKeyResolver(
    deps: StoredSigningKeyResolverDeps
): (did: string) => Promise<string | null> {
    void deps
    void extractSigningKey
    void SIGNING_KEY_TTL_MS
    throw new Error("not implemented")
}
