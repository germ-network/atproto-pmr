/**
 * Cached DID documents (`spec/proxy-cache.md`, "The model"). The signing key
 * and PDS endpoint are read from the cached document instead of a fresh
 * directory fetch.
 */

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
