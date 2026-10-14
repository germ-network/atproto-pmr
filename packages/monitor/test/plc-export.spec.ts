/**
 * The PLC export stream: decoding an operation into what it means for the
 * DID's stored document, the cursor's fate on close, and the read-loop intake
 * that acts only on watched DIDs.
 */
import { describe, expect, it } from "vitest"
import { renderPlcDocument } from "@germ-network/atproto-pmr-core"
import {
    decodePlcExportFrame,
    intakePlcEvent,
    plcCursorAfterClose,
    type PlcExportEvent,
    type PlcIntakeDeps,
} from "../src/plc-export"

/** A live `sequenced_op` entry from plc.directory's `/export`, the shape its stream sends. */
const DID = "did:plc:5jp6kvueqebbcuf77rd5sqtj"
const OPERATION = {
    sig: "tJ9NZHpkXQh_iawer2JvrbA-U-kGRshvLKV-_Xi8eOUn-5p7My565C5FbmsjWoCnrRWmE_vjXeJCfOlS6uYABQ",
    prev: null,
    type: "plc_operation",
    services: {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://bsky.social" },
    },
    alsoKnownAs: ["at://iuritg.bsky.social"],
    rotationKeys: [
        "did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg",
        "did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK",
    ],
    verificationMethods: { atproto: "did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF" },
}

function frame(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        did: DID,
        cid: "bafyreihkl7svnbebaiivbp74i7mue2kqmllc2ygtmlnrnhmf2y5im5qura",
        seq: 1000001,
        createdAt: "2023-09-04T02:25:42.341Z",
        operation: OPERATION,
        type: "sequenced_op",
        ...overrides,
    })
}

describe("decodePlcExportFrame", () => {
    it("a plc_operation decodes to render, with the document renderPlcDocument gives for it", () => {
        const event = decodePlcExportFrame(frame())
        expect(event?.change).toEqual({
            kind: "render",
            document: renderPlcDocument(DID, OPERATION),
        })
        expect(event?.change.kind === "render" && event.change.document.id).toBe(DID)
    })

    it("a plc_tombstone decodes to tombstone", () => {
        const event = decodePlcExportFrame(
            frame({ operation: { type: "plc_tombstone", prev: "bafy", sig: "x" } })
        )
        expect(event?.change).toEqual({ kind: "tombstone" })
    })

    it("a legacy create decodes to refetch", () => {
        const event = decodePlcExportFrame(
            frame({ operation: { ...OPERATION, type: "create" } })
        )
        expect(event?.change).toEqual({ kind: "refetch" })
    })

    it("an unknown operation type decodes to refetch", () => {
        const event = decodePlcExportFrame(
            frame({ operation: { ...OPERATION, type: "plc_something_new" } })
        )
        expect(event?.change).toEqual({ kind: "refetch" })
        expect(decodePlcExportFrame(frame({ operation: {} }))?.change).toEqual({ kind: "refetch" })
        expect(decodePlcExportFrame(frame({ operation: "op" }))?.change).toEqual({ kind: "refetch" })
    })

    it("a plc_operation that does not render decodes to refetch", () => {
        const event = decodePlcExportFrame(
            frame({ operation: { ...OPERATION, services: {} } })
        )
        expect(event?.change).toEqual({ kind: "refetch" })
    })

    it("keeps seq and did from the frame, and createdAt as createdAtMs", () => {
        const event = decodePlcExportFrame(frame())
        expect(event).toMatchObject({
            seq: 1000001,
            did: DID,
            createdAtMs: Date.parse("2023-09-04T02:25:42.341Z"),
        })
    })

    it("returns null for an unparseable createdAt", () => {
        for (const createdAt of ["yesterday", "", 5, null]) {
            expect(decodePlcExportFrame(frame({ createdAt }))).toBeNull()
        }
        const { createdAt: _, ...noCreatedAt } = JSON.parse(frame())
        expect(decodePlcExportFrame(JSON.stringify(noCreatedAt))).toBeNull()
    })

    it("returns null for a missing, negative, fractional or unsafe seq", () => {
        for (const seq of [-1, 1.5, 2 ** 53, "7", null, Number.NaN]) {
            expect(decodePlcExportFrame(frame({ seq }))).toBeNull()
        }
        const { seq: _, ...noSeq } = JSON.parse(frame())
        expect(decodePlcExportFrame(JSON.stringify(noSeq))).toBeNull()
        expect(decodePlcExportFrame(frame({ seq: 0 }))?.seq).toBe(0)
    })

    it("returns null for a did that is not did:plc:", () => {
        for (const did of ["did:web:example.com", "plc:abc", "", 7]) {
            expect(decodePlcExportFrame(frame({ did }))).toBeNull()
        }
    })

    it("returns null when type is not sequenced_op", () => {
        expect(decodePlcExportFrame(frame({ type: "other" }))).toBeNull()
        const { type: _, ...noType } = JSON.parse(frame())
        expect(decodePlcExportFrame(JSON.stringify(noType))).toBeNull()
    })

    it("returns null for text that is not a JSON object", () => {
        for (const raw of ["", "not json", "null", "[1]", "7", '"x"']) {
            expect(decodePlcExportFrame(raw)).toBeNull()
        }
    })
})

describe("plcCursorAfterClose", () => {
    it("OutdatedCursor resets the cursor", () => {
        expect(plcCursorAfterClose("OutdatedCursor")).toBe("reset")
    })

    it("FutureCursor resets the cursor", () => {
        expect(plcCursorAfterClose("FutureCursor")).toBe("reset")
    })

    it("ConsumerTooSlow keeps the cursor", () => {
        expect(plcCursorAfterClose("ConsumerTooSlow")).toBe("keep")
    })

    it("an empty or unknown reason keeps the cursor", () => {
        for (const reason of ["", "going away", "outdatedcursor", "SomethingElse"]) {
            expect(plcCursorAfterClose(reason)).toBe("keep")
        }
    })
})

describe("intakePlcEvent", () => {
    const AT = 1_693_000_000_000

    /** In-memory index and sink that log every call, in order. */
    function fakes(opts: {
        watched?: boolean
        rev?: string | null
        deleted?: boolean
        failRecord?: boolean
        failOwe?: boolean
    } = {}) {
        const log: string[] = []
        const calls = {
            recorded: [] as Array<[string, unknown, number]>,
            stale: [] as Array<[string, number]>,
            owed: [] as Array<[string, string]>,
            cursor: [] as Array<[number, number]>,
        }
        const deps = {
            index: {
                isWatched: async () => opts.watched ?? true,
                revOf: async () => (opts.rev === undefined ? "3m1" : opts.rev),
                isDeleted: async () => opts.deleted ?? false,
                owe: async (did: string, rev: string) => {
                    log.push("owe")
                    if (opts.failOwe) throw new Error("sqlite down")
                    calls.owed.push([did, rev])
                },
                advancePlcCursor: async (seq: number, createdAtMs: number) => {
                    log.push("cursor")
                    calls.cursor.push([seq, createdAtMs])
                },
            } as unknown as PlcIntakeDeps["index"],
            didDocuments: {
                recordDidDocument: async (did: string, document: unknown, asOfMs: number) => {
                    log.push("record")
                    if (opts.failRecord) throw new Error("sqlite down")
                    calls.recorded.push([did, document, asOfMs])
                },
                markDidDocumentStale: async (did: string, asOfMs: number) => {
                    log.push("stale")
                    calls.stale.push([did, asOfMs])
                },
            },
        }
        return { deps, calls, log }
    }
    const event = (change: PlcExportEvent["change"], seq = 42): PlcExportEvent => ({
        seq,
        did: DID,
        createdAtMs: AT,
        change,
    })
    const RENDER = { kind: "render", document: { id: DID } } as const

    it("an unwatched DID only advances the cursor, and answers ignored", async () => {
        const f = fakes({ watched: false })
        expect(await intakePlcEvent(f.deps, event(RENDER))).toBe("ignored")
        expect(f.log).toEqual(["cursor"])
        expect(f.calls.cursor).toEqual([[42, AT]])
    })

    it("a watched DID's render is stored as of the op's createdAt, and answers stored", async () => {
        const f = fakes()
        expect(await intakePlcEvent(f.deps, event(RENDER))).toBe("stored")
        expect(f.calls.recorded).toEqual([[DID, { id: DID }, AT]])
        expect(f.calls.stale).toEqual([])
    })

    it("a watched DID's tombstone stores a null document, and answers stored", async () => {
        const f = fakes()
        expect(await intakePlcEvent(f.deps, event({ kind: "tombstone" }))).toBe("stored")
        expect(f.calls.recorded).toEqual([[DID, null, AT]])
    })

    it("a watched DID's refetch marks the stored document stale as of the op's createdAt, and answers refetch", async () => {
        const f = fakes()
        expect(await intakePlcEvent(f.deps, event({ kind: "refetch" }))).toBe("refetch")
        expect(f.calls.stale).toEqual([[DID, AT]])
        expect(f.calls.recorded).toEqual([])
    })

    it("a confirmed-deleted DID's refetch still marks the stored document stale", async () => {
        const f = fakes({ deleted: true })
        expect(await intakePlcEvent(f.deps, event({ kind: "refetch" }))).toBe("refetch")
        expect(f.calls.stale).toEqual([[DID, AT]])
    })

    it("any change for a DID in the rev index owes a snapshot re-fetch at its indexed rev", async () => {
        for (const change of [RENDER, { kind: "tombstone" }, { kind: "refetch" }] as const) {
            const f = fakes({ rev: "3m7" })
            await intakePlcEvent(f.deps, event(change))
            expect(f.calls.owed).toEqual([[DID, "3m7"]])
        }
    })

    it("a confirmed-deleted DID's render is stored but no re-fetch is owed", async () => {
        const f = fakes({ deleted: true })
        expect(await intakePlcEvent(f.deps, event(RENDER))).toBe("stored")
        expect(f.calls.recorded).toHaveLength(1)
        expect(f.calls.owed).toEqual([])
    })

    it("a watched DID that is only owed a fetch is not owed again", async () => {
        const f = fakes({ rev: null })
        await intakePlcEvent(f.deps, event(RENDER))
        expect(f.calls.recorded).toHaveLength(1)
        expect(f.calls.owed).toEqual([])
    })

    it("advances the cursor after the document and the obligation are written", async () => {
        const f = fakes()
        await intakePlcEvent(f.deps, event(RENDER))
        expect(f.log).toEqual(["record", "owe", "cursor"])
        const g = fakes()
        await intakePlcEvent(g.deps, event({ kind: "refetch" }))
        expect(g.log).toEqual(["stale", "owe", "cursor"])
    })

    it("a failed obligation write leaves the cursor where it was", async () => {
        const f = fakes({ failOwe: true })
        await expect(intakePlcEvent(f.deps, event(RENDER))).rejects.toThrow("sqlite down")
        expect(f.calls.cursor).toEqual([])
    })

    it("a failed document write leaves the cursor where it was", async () => {
        const f = fakes({ failRecord: true })
        await expect(intakePlcEvent(f.deps, event(RENDER))).rejects.toThrow("sqlite down")
        expect(f.calls.cursor).toEqual([])
        expect(f.calls.owed).toEqual([])
    })
})
