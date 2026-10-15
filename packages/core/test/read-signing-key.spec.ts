/**
 * A public read serves a snapshot only while its ingest key is the DID's
 * trusted current key; it never fetches one, so with none trusted a did:plc
 * read fails closed and a did:web read relies on the ingest verdict.
 */
import { describe, expect, it } from "vitest"
import { SIGNING_KEY_TTL_MS } from "../src/atproto-fetch"
import {
    PLC_COVERAGE_MAX_LAG_MS,
    type CachedDidDocument,
    type PlcCoverage,
} from "../src/did-document"
import { readSigningKeyFrom, servableUnderRotation } from "../src/read-signing-key"

const NOW = 100_000_000_000
const PLC = "did:plc:alice1234567890123456789012"
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const HOUR = 3_600_000

const document = (
    fetchedAtMs: number,
    options: { key?: string | null; source?: "plc" | "web"; id?: string } = {}
): CachedDidDocument => ({
    doc: {
        id: options.id ?? PLC,
        verificationMethod:
            options.key === null
                ? []
                : [
                      {
                          id: `${options.id ?? PLC}#atproto`,
                          type: "Multikey",
                          controller: options.id ?? PLC,
                          publicKeyMultibase: options.key ?? KEY,
                      },
                  ],
    },
    fetchedAtMs,
    source: options.source ?? "plc",
})

const coverage = (continuousSinceMs: number, coveredThroughMs = NOW): PlcCoverage => ({
    url: "wss://plc.example/export",
    continuousSinceMs,
    coveredThroughMs,
})

describe("readSigningKeyFrom", () => {
    it("a did:plc document fetched within the continuous coverage run, coverage current, is trusted however old", () => {
        const fetched = NOW - 30 * 24 * HOUR
        expect(
            readSigningKeyFrom(PLC, document(fetched), coverage(fetched), NOW)
        ).toEqual({ kind: "trusted", key: KEY })
        // Coverage is only vouched for the stream's own documents.
        expect(
            readSigningKeyFrom(PLC, document(fetched, { source: "web" }), coverage(fetched), NOW)
        ).toEqual({ kind: "unknown" })
    })

    it("a did:plc document fetched before continuousSinceMs is trusted only for SIGNING_KEY_TTL_MS", () => {
        const inside = readSigningKeyFrom(
            PLC,
            document(NOW - SIGNING_KEY_TTL_MS),
            coverage(NOW),
            NOW
        )
        expect(inside).toEqual({ kind: "trusted", key: KEY })
        expect(
            readSigningKeyFrom(PLC, document(NOW - SIGNING_KEY_TTL_MS - 1), coverage(NOW), NOW)
        ).toEqual({ kind: "unknown" })
        // No coverage at all is the same.
        expect(
            readSigningKeyFrom(PLC, document(NOW - SIGNING_KEY_TTL_MS - 1), null, NOW)
        ).toEqual({ kind: "unknown" })
    })

    it("coverage lagging past PLC_COVERAGE_MAX_LAG_MS trusts only for SIGNING_KEY_TTL_MS", () => {
        const fetched = NOW - 2 * HOUR
        const lagging = coverage(fetched - HOUR, NOW - PLC_COVERAGE_MAX_LAG_MS - 1)
        expect(readSigningKeyFrom(PLC, document(fetched), lagging, NOW)).toEqual({ kind: "unknown" })
        const atBound = coverage(fetched - HOUR, NOW - PLC_COVERAGE_MAX_LAG_MS)
        expect(readSigningKeyFrom(PLC, document(fetched), atBound, NOW)).toEqual({
            kind: "trusted",
            key: KEY,
        })
        expect(
            readSigningKeyFrom(PLC, document(NOW - 1000), lagging, NOW)
        ).toEqual({ kind: "trusted", key: KEY })
    })

    it("no cached document, or one past its window, is unknown", () => {
        expect(readSigningKeyFrom(PLC, null, coverage(0), NOW)).toEqual({ kind: "unknown" })
        expect(
            readSigningKeyFrom(PLC, document(Number.NaN), coverage(0), NOW)
        ).toEqual({ kind: "unknown" })
    })

    it("a document with no #atproto key is unknown", () => {
        expect(
            readSigningKeyFrom(PLC, document(NOW, { key: null }), coverage(0), NOW)
        ).toEqual({ kind: "unknown" })
    })

    it("a did:web DID is unchecked, whatever is cached", () => {
        const web = "did:web:example.com"
        expect(readSigningKeyFrom(web, null, null, NOW)).toEqual({ kind: "unchecked" })
        expect(
            readSigningKeyFrom(web, document(NOW, { source: "web", id: web }), coverage(0), NOW)
        ).toEqual({ kind: "unchecked" })
    })
})

describe("servableUnderRotation", () => {
    it("a trusted key equal to verifiedWith is servable", () => {
        expect(servableUnderRotation(KEY, { kind: "trusted", key: KEY })).toBe(true)
    })

    it("a trusted key different from verifiedWith is not", () => {
        expect(servableUnderRotation(KEY, { kind: "trusted", key: "zOther" })).toBe(false)
    })

    it("unknown is not servable", () => {
        expect(servableUnderRotation(KEY, { kind: "unknown" })).toBe(false)
    })

    it("unchecked is servable", () => {
        expect(servableUnderRotation(KEY, { kind: "unchecked" })).toBe(true)
    })
})
