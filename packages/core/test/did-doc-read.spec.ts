/**
 * The DID-document route gives every caller the same answer, from held
 * state only: a did:plc log a device verifies itself, a did:web document as
 * a hint, or a miss.
 */
import { describe, expect, it } from "vitest"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import {
    DID_DOC_READ_KEYS,
    PLC_LOG_ENTRY_KEYS,
    decodeDidDocReadResponse,
    encodeDidDocReadResponse,
    handleDidDocRead,
    type DidDocReadDeps,
    type DidDocReadResponse,
} from "../src/did-doc-read"
import type { PlcCoverage } from "../src/did-document"
import { verifyPlcLog, type PlcLog } from "../src/plc-log"
import modern from "./fixtures/plc-log-modern.json"
import { parsePlcAuditLog } from "../src/plc-log"

const PLC = modern.did
const WEB = "did:web:example.com"
const coverage: PlcCoverage = { url: "wss://plc.example/export", continuousSinceMs: 1_000, coveredThroughMs: 9_000 }
const log: PlcLog = { did: PLC, entries: parsePlcAuditLog(PLC, modern.audit)!, asOfMs: 5_000 }
const webDoc = { id: WEB, alsoKnownAs: ["at://x.test"] }

const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://pmr.example${path}`, { headers })

function setup(options: { serves?: boolean; log?: PlcLog | null; web?: boolean; coverage?: PlcCoverage | null } = {}) {
    const asked: string[] = []
    const deps: DidDocReadDeps = {
        logs: {
            get: async (did) => {
                asked.push(`log ${did}`)
                return options.log === undefined ? log : options.log
            },
        },
        documents: {
            get: async (did) => {
                asked.push(`doc ${did}`)
                return options.web === false ? null : { doc: webDoc, fetchedAtMs: 7_000, source: "web" }
            },
        },
        getPlcCoverage: async () => (options.coverage === undefined ? coverage : options.coverage),
        serves: async () => options.serves ?? true,
    }
    return { deps, asked }
}

async function read(path: string, deps: DidDocReadDeps) {
    const res = await handleDidDocRead(get(path), deps)
    return { res, body: decodeDidDocReadResponse(new Uint8Array(await res.arrayBuffer())) }
}

describe("handleDidDocRead", () => {
    it("a served did:plc DID with a held log returns its entries, asOfMs and coverage", async () => {
        const { deps } = setup()
        const { body } = await read(`/pmr/v1/did/${PLC}`, deps)
        expect(body).toEqual({
            found: true,
            method: "plc",
            did: PLC,
            entries: log.entries,
            asOfMs: 5_000,
            coverage,
        })
        // What a device receives verifies to the document the directory renders.
        if (body.found && body.method === "plc") {
            expect(verifyPlcLog(PLC, body.entries)).toEqual(modern.document)
        }
        const uncovered = await read(`/pmr/v1/did/${PLC}`, setup({ coverage: null }).deps)
        expect(uncovered.body).toMatchObject({ found: true, method: "plc", coverage: null })
    })

    it("a served did:web DID returns its cached document", async () => {
        const { body } = await read(`/pmr/v1/did/${encodeURIComponent(WEB)}`, setup().deps)
        expect(body).toEqual({ found: true, method: "web", did: WEB, doc: webDoc, fetchedAtMs: 7_000 })
    })

    it("a DID not served reads not-watched", async () => {
        const { deps, asked } = setup({ serves: false })
        expect((await read(`/pmr/v1/did/${PLC}`, deps)).body).toMatchObject({ found: false, code: "not-watched" })
        expect(asked).toEqual([])
        // A DID method this relay does not cover is the same answer.
        const other = await read("/pmr/v1/did/did:key:zabc", setup().deps)
        expect(other.body).toMatchObject({ found: false, code: "not-watched" })
    })

    it("a served DID with nothing held reads not-held", async () => {
        expect((await read(`/pmr/v1/did/${PLC}`, setup({ log: null }).deps)).body).toMatchObject({
            found: false,
            code: "not-held",
        })
        expect((await read(`/pmr/v1/did/${WEB}`, setup({ web: false }).deps)).body).toMatchObject({
            found: false,
            code: "not-held",
        })
    })

    it("a store fault is a relay fault, not a miss", async () => {
        const { deps } = setup()
        const failing: DidDocReadDeps = {
            ...deps,
            logs: { get: async () => Promise.reject(new Error("store down")) },
            documents: { get: async () => Promise.reject(new Error("store down")) },
        }
        await expect(handleDidDocRead(get(`/pmr/v1/did/${PLC}`), failing)).rejects.toThrow("store down")
        await expect(handleDidDocRead(get(`/pmr/v1/did/${WEB}`), failing)).rejects.toThrow("store down")
    })

    it("a malformed path is 400", async () => {
        const { deps, asked } = setup()
        for (const path of ["/pmr/v1/did", "/pmr/v1/did/", "/pmr/v1/did/notadid", "/pmr/v1/did/did:plc:a/extra", "/pmr/v1/did/%E0%A4%A", "/pmr/v1/dids/did:plc:abc", `/pmr/v1/did/${PLC}%2Fx`]) {
            const res = await handleDidDocRead(get(path), deps)
            expect(res.status, path).toBe(400)
            expect(res.headers.get("cache-control")).toBe("no-store")
        }
        expect(asked).toEqual([])
    })

    it("responses are 200, no-store, with no validators", async () => {
        const { deps } = setup()
        for (const path of [`/pmr/v1/did/${PLC}`, `/pmr/v1/did/${WEB}`, "/pmr/v1/did/did:plc:zzzzzzzzzzzzzzzzzzzzzzzz"]) {
            const a = await handleDidDocRead(get(path), deps)
            const b = await handleDidDocRead(get(path, { authorization: "Bearer x", "if-none-match": "*", cookie: "a=b" }), deps)
            expect(a.status).toBe(200)
            expect(a.headers.get("cache-control")).toBe("no-store")
            expect(a.headers.get("content-type")).toBe("application/cbor")
            expect(a.headers.get("etag")).toBeNull()
            expect(a.headers.get("last-modified")).toBeNull()
            expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array(await a.arrayBuffer()))
        }
    })
})

describe("did-doc read codec", () => {
    const variants: DidDocReadResponse[] = [
        { found: true, method: "plc", did: PLC, entries: log.entries, asOfMs: 5_000, coverage },
        { found: true, method: "plc", did: PLC, entries: log.entries, asOfMs: 5_000, coverage: null },
        {
            found: true,
            method: "plc",
            did: PLC,
            entries: log.entries.map((e, i) => (i === 1 ? { ...e, nullified: true } : e)),
            asOfMs: 5_000,
            coverage,
        },
        { found: true, method: "web", did: WEB, doc: webDoc, fetchedAtMs: 7_000 },
        { found: false, code: "not-watched", reason: "not watched" },
        { found: false, code: "not-held", reason: "none" },
    ]

    it("each variant round-trips", () => {
        for (const v of variants) {
            expect(decodeDidDocReadResponse(encodeDidDocReadResponse(v))).toEqual(v)
        }
    })

    it("each operation travels as its JSON text, byte for byte", () => {
        const bytes = encodeDidDocReadResponse(variants[0]!)
        const map = decodeCoseMap(bytes)
        const entries = map.get(DID_DOC_READ_KEYS.entries) as Map<string, CoseValue>[]
        expect(entries).toHaveLength(log.entries.length)
        entries.forEach((e, i) => {
            expect(e.get(PLC_LOG_ENTRY_KEYS.operation)).toBe(JSON.stringify(log.entries[i]!.operation))
        })
    })

    it("unknown keys are ignored; a missing required field throws", () => {
        const base = (): Map<string, CoseValue> =>
            new Map<string, CoseValue>([
                [DID_DOC_READ_KEYS.found, true],
                [DID_DOC_READ_KEYS.method, "web"],
                [DID_DOC_READ_KEYS.did, WEB],
                [DID_DOC_READ_KEYS.doc, JSON.stringify(webDoc)],
                [DID_DOC_READ_KEYS.fetchedAtMs, 7],
            ])
        const extra = base()
        extra.set("zz", "extra")
        expect(decodeDidDocReadResponse(encodeCose(extra))).toMatchObject({ found: true, method: "web" })
        for (const key of Object.values(DID_DOC_READ_KEYS)) {
            if (!base().has(key)) continue
            const m = base()
            m.delete(key)
            expect(() => decodeDidDocReadResponse(encodeCose(m)), key).toThrow()
        }
        // A plc body without its coverage key, or with a malformed entry, throws too.
        const plc = encodeDidDocReadResponse(variants[0]!)
        const dropped = decodeCoseMap(plc)
        dropped.delete(DID_DOC_READ_KEYS.coverage)
        expect(() => decodeDidDocReadResponse(encodeCose(dropped as Map<string, CoseValue>))).toThrow()
        const badEntry = decodeCoseMap(plc)
        badEntry.set(DID_DOC_READ_KEYS.entries, [new Map<string, CoseValue>([["c", "x"]])])
        expect(() => decodeDidDocReadResponse(encodeCose(badEntry as Map<string, CoseValue>))).toThrow()
        expect(() => decodeDidDocReadResponse(encodeCose(new Map<string, CoseValue>([[DID_DOC_READ_KEYS.found, "yes"]])))).toThrow()
        // Times are non-negative integers.
        for (const bad of [-1, 1.5]) {
            const m = decodeCoseMap(plc)
            m.set(DID_DOC_READ_KEYS.asOfMs, bad)
            expect(() => decodeDidDocReadResponse(encodeCose(m as Map<string, CoseValue>)), String(bad)).toThrow()
        }
    })
})
