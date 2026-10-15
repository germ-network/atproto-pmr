/**
 * The device read API's DID-document route: what a device needs to trust a
 * DID's current keys without trusting the PMR. For did:plc that is the
 * signed operation log, which it verifies itself; a did:web document cannot
 * be verified that way, so it is a hint the device may re-fetch over HTTPS.
 */

import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import { DID_SYNTAX } from "./device-read.js"
import type { DidDocument, DidDocumentCache, PlcCoverage } from "./did-document"
import type { PlcLog, PlcLogEntry } from "./plc-log"
import { toResponseBody } from "./util.js"

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
 * verifies the fields the controller signed. That is the object the monitor
 * verified before storing it, and every signed field of a did:plc operation is
 * a string, array, map or null, which JSON carries exactly. `fetchedAtMs` and
 * `asOfMs` are the monitor's clock; a device compares them to its own.
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

export const PLC_COVERAGE_KEYS = {
    url: "u",
    continuousSinceMs: "s",
    coveredThroughMs: "c",
} as const satisfies Record<keyof PlcCoverage, string>

export function encodeDidDocReadResponse(response: DidDocReadResponse): Uint8Array {
    const K = DID_DOC_READ_KEYS
    const entries: [string, CoseValue][] = !response.found
        ? [
              [K.found, false],
              [K.code, response.code],
              [K.reason, response.reason],
          ]
        : response.method === "plc"
          ? [
                [K.found, true],
                [K.method, "plc"],
                [K.did, response.did],
                [K.entries, response.entries.map(entryToCose)],
                [K.asOfMs, response.asOfMs],
                [K.coverage, response.coverage === null ? null : coverageToCose(response.coverage)],
            ]
          : [
                [K.found, true],
                [K.method, "web"],
                [K.did, response.did],
                [K.doc, JSON.stringify(response.doc)],
                [K.fetchedAtMs, response.fetchedAtMs],
            ]
    return encodeCose(new Map<string, CoseValue>(entries))
}

function entryToCose(entry: PlcLogEntry): Map<string, CoseValue> {
    const E = PLC_LOG_ENTRY_KEYS
    return new Map<string, CoseValue>([
        [E.cid, entry.cid],
        [E.operation, JSON.stringify(entry.operation)],
        [E.createdAtMs, entry.createdAtMs],
        [E.nullified, entry.nullified],
    ])
}

function coverageToCose(coverage: PlcCoverage): Map<string, CoseValue> {
    const C = PLC_COVERAGE_KEYS
    return new Map<string, CoseValue>([
        [C.url, coverage.url],
        [C.continuousSinceMs, coverage.continuousSinceMs],
        [C.coveredThroughMs, coverage.coveredThroughMs],
    ])
}

type CoseMap = Map<number | string, CoseValue>

/** Ignores keys it does not know; throws on a body missing a required field. */
export function decodeDidDocReadResponse(bytes: Uint8Array): DidDocReadResponse {
    const K = DID_DOC_READ_KEYS
    const map = decodeCoseMap(bytes)
    const bad = (key: string): never => {
        throw new Error(`did-doc read: missing or malformed "${key}"`)
    }
    const str = (m: CoseMap, key: string): string => {
        const v = m.get(key)
        return typeof v === "string" ? v : bad(key)
    }
    const num = (m: CoseMap, key: string): number => {
        const v = m.get(key)
        return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(key)
    }
    const json = (m: CoseMap, key: string): unknown => {
        try {
            return JSON.parse(str(m, key))
        } catch {
            return bad(key)
        }
    }
    const found = map.get(K.found)
    if (found === false) {
        const code = str(map, K.code)
        if (code !== "not-watched" && code !== "not-held") return bad(K.code)
        return { found: false, code, reason: str(map, K.reason) }
    }
    if (found !== true) return bad(K.found)
    const method = str(map, K.method)
    if (method === "web") {
        const doc = json(map, K.doc)
        if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return bad(K.doc)
        return {
            found: true,
            method: "web",
            did: str(map, K.did),
            doc: doc as DidDocument,
            fetchedAtMs: num(map, K.fetchedAtMs),
        }
    }
    if (method !== "plc") return bad(K.method)
    const list = map.get(K.entries)
    if (!Array.isArray(list)) return bad(K.entries)
    const E = PLC_LOG_ENTRY_KEYS
    const entries = list.map((item): PlcLogEntry => {
        if (!(item instanceof Map)) return bad(K.entries)
        const operation = json(item, E.operation)
        if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
            return bad(E.operation)
        }
        const nullified = item.get(E.nullified)
        if (typeof nullified !== "boolean") return bad(E.nullified)
        return {
            cid: str(item, E.cid),
            operation: operation as Record<string, unknown>,
            createdAtMs: num(item, E.createdAtMs),
            nullified,
        }
    })
    const rawCoverage = map.get(K.coverage)
    let coverage: PlcCoverage | null = null
    if (rawCoverage !== null) {
        if (!(rawCoverage instanceof Map)) return bad(K.coverage)
        const C = PLC_COVERAGE_KEYS
        coverage = {
            url: str(rawCoverage, C.url),
            continuousSinceMs: num(rawCoverage, C.continuousSinceMs),
            coveredThroughMs: num(rawCoverage, C.coveredThroughMs),
        }
    }
    return {
        found: true,
        method: "plc",
        did: str(map, K.did),
        entries,
        asOfMs: num(map, K.asOfMs),
        coverage,
    }
}

/**
 * `GET /pmr/v1/did/{did}` — a CBOR {@link DidDocReadResponse}, `200` whether
 * found or not, `cache-control: no-store`, `400` for a malformed path.
 * Unauthenticated and the same for every caller; never reaches the
 * directory or a did:web host.
 */
export async function handleDidDocRead(
    request: Request,
    deps: DidDocReadDeps
): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/")
    // "", "pmr", "v1", "did", did
    let did: string | null = null
    if (parts.length === 5 && parts[1] === "pmr" && parts[2] === "v1" && parts[3] === "did") {
        try {
            const decoded = decodeURIComponent(parts[4]!)
            if (DID_SYNTAX.test(decoded)) did = decoded
        } catch {
            // malformed escape: same 400 as any other bad path
        }
    }
    if (did === null) {
        return new Response("Malformed path", {
            status: 400,
            headers: { "cache-control": "no-store" },
        })
    }
    return reply(await read(did, deps))
}

async function read(did: string, deps: DidDocReadDeps): Promise<DidDocReadResponse> {
    const isPlc = did.startsWith("did:plc:")
    if ((!isPlc && !did.startsWith("did:web:")) || !(await deps.serves(did))) {
        return { found: false, code: "not-watched", reason: "not watched" }
    }
    if (isPlc) {
        const log = await deps.logs.get(did)
        if (!log) return { found: false, code: "not-held", reason: "no operation log held" }
        return {
            found: true,
            method: "plc",
            did,
            entries: log.entries,
            asOfMs: log.asOfMs,
            coverage: await deps.getPlcCoverage(),
        }
    }
    const cached = await deps.documents.get(did)
    if (!cached) return { found: false, code: "not-held", reason: "no document held" }
    return { found: true, method: "web", did, doc: cached.doc, fetchedAtMs: cached.fetchedAtMs }
}

function reply(body: DidDocReadResponse): Response {
    return new Response(toResponseBody(encodeDidDocReadResponse(body)), {
        status: 200,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
    })
}
