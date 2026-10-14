/**
 * The PLC export stream: decoding an operation into what it means for the
 * DID's stored document, the cursor's fate on close, and the read-loop intake
 * that acts only on watched DIDs.
 */
import { describe, expect, it } from "vitest"
import { renderPlcDocument } from "@germ-network/atproto-pmr-core"
import { decodePlcExportFrame } from "../src/plc-export"

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
    it.todo("OutdatedCursor resets the cursor")
    it.todo("FutureCursor resets the cursor")
    it.todo("ConsumerTooSlow keeps the cursor")
    it.todo("an empty or unknown reason keeps the cursor")
})

describe("intakePlcEvent", () => {
    it.todo("an unwatched DID only advances the cursor, and answers ignored")
    it.todo("a watched DID's render is stored as of the op's createdAt, and answers stored")
    it.todo("a watched DID's tombstone stores a null document, and answers stored")
    it.todo("a watched DID's refetch marks the stored document stale as of the op's createdAt, and answers refetch")
    it.todo("a confirmed-deleted DID's refetch still marks the stored document stale")
    it.todo("any change for a DID in the rev index owes a snapshot re-fetch at its indexed rev")
    it.todo("a confirmed-deleted DID's render is stored but no re-fetch is owed")
    it.todo("a watched DID that is only owed a fetch is not owed again")
    it.todo("advances the cursor after the document and the obligation are written")
    it.todo("a failed document write leaves the cursor where it was")
})
