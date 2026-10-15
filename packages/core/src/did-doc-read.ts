/**
 * The device read API's DID-document route: what a device needs to trust a
 * DID's current keys without trusting the PMR. For did:plc that is the
 * signed operation log, which it verifies itself; a did:web document cannot
 * be verified that way, so it is a hint the device may re-fetch over HTTPS.
 */

import type { DidDocument, DidDocumentCache, PlcCoverage } from "./did-document"
import type { PlcLog, PlcLogEntry } from "./plc-log"

export type DidDocReadMiss = "not-watched" | "not-held"

export type DidDocReadResponse =
    | {
          found: true
          method: "plc"
          did: string
          entries: PlcLogEntry[]
          /** {@link PlcLog.asOfMs}. */
          asOfMs: number
          /**
           * The monitor's stream coverage: an operation the directory
           * accepted after `asOfMs` within it would have reached the log.
           * Null when uncovered.
           */
          coverage: PlcCoverage | null
      }
    | { found: true; method: "web"; did: string; doc: DidDocument; fetchedAtMs: number }
    | { found: false; code: DidDocReadMiss; reason: string }

export interface PlcLogStore {
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    get(did: string): Promise<PlcLog | null>
}

export interface DidDocReadDeps {
    logs: PlcLogStore
    /** For did:web. */
    documents: DidDocumentCache
    getPlcCoverage: () => Promise<PlcCoverage | null>
    /** As for record reads: any other DID reads `not-watched`. */
    serves: (did: string) => Promise<boolean>
}

/**
 * Wire keys; a decoder ignores keys it does not know. Each operation is
 * carried as JSON text, re-serialised from the stored object: a device
 * re-encodes it as DAG-CBOR, which does not depend on key order, and
 * verifies the fields the controller signed.
 */
export const DID_DOC_READ_KEYS = {
    found: "f",
    method: "m",
    did: "d",
    entries: "l",
    asOfMs: "a",
    coverage: "v",
    doc: "o",
    fetchedAtMs: "t",
    code: "e",
    reason: "r",
} as const

export const PLC_LOG_ENTRY_KEYS = {
    cid: "c",
    operation: "o",
    createdAtMs: "t",
    nullified: "n",
} as const

export function encodeDidDocReadResponse(_response: DidDocReadResponse): Uint8Array {
    throw new Error("not implemented")
}

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeDidDocReadResponse(_bytes: Uint8Array): DidDocReadResponse {
    throw new Error("not implemented")
}

/**
 * `GET /pmr/v1/did/{did}` — a CBOR {@link DidDocReadResponse}, `200` whether
 * found or not, `cache-control: no-store`, `400` for a malformed path.
 * Unauthenticated and the same for every caller; never reaches the
 * directory or a did:web host.
 */
export async function handleDidDocRead(
    _request: Request,
    _deps: DidDocReadDeps
): Promise<Response> {
    throw new Error("not implemented")
}
