/**
 * The PLC export stream as a signing-key cache signal: decode, intake in the
 * read loop, and the drain that reaches the cache.
 */
import { describe, expect, it } from "vitest"
import { decodePlcExportFrame } from "../src/plc-export"

/** The frame plc.directory's export serves for seq 20000001. */
const LIVE_FRAME = JSON.stringify({
    did: "did:plc:2sy7cqhmlt4meg23czfj7faa",
    cid: "bafyreiguwhyub3c47dbbwwywjkpziaekmflxkscyyhtegexyba5aomczza",
    seq: 20000001,
    createdAt: "2024-11-14T16:09:41.634Z",
    operation: {
        sig: "pXUFgzZCWzas-9vqMrmukPAIvlI_siq6F5sES9caXRw1iySkhvHx4_v1HHNpY0r7xOp03OXdp5I7UFCrdjvlTQ",
        prev: null,
        type: "plc_operation",
        services: {
            atproto_pds: {
                type: "AtprotoPersonalDataServer",
                endpoint: "https://milkcap.us-west.host.bsky.network",
            },
        },
        alsoKnownAs: ["at://naifff.bsky.social"],
        rotationKeys: [
            "did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg",
            "did:key:zQ3shpKnbdPx3g3CmPf5cRVTPe1HtSwVn5ish3wSnDPQCbLJK",
        ],
        verificationMethods: {
            atproto: "did:key:zQ3shhLLHJy4jrDPvv2rJFN9iQ4bwYaoW5GucxZGW2j7i8bNM",
        },
    },
    type: "sequenced_op",
})

describe("decodePlcExportFrame", () => {
    const frame = (over: Record<string, unknown> = {}, op: Record<string, unknown> = {}) =>
        JSON.stringify({
            type: "sequenced_op",
            seq: 7,
            did: "did:plc:abc",
            cid: "bafy",
            createdAt: "2026-10-13T00:00:00.071Z",
            operation: {
                type: "plc_operation",
                verificationMethods: { atproto: "did:key:zKey1" },
                ...op,
            },
            ...over,
        })

    it("plc_operation → put with verificationMethods.atproto minus the did:key: prefix, asOfMs = createdAt", () => {
        expect(decodePlcExportFrame(frame())).toEqual({
            seq: 7,
            did: "did:plc:abc",
            update: { kind: "put", key: "zKey1", asOfMs: Date.parse("2026-10-13T00:00:00.071Z") },
        })
    })

    it("plc_operation with a missing or unparseable createdAt → delete", () => {
        expect(decodePlcExportFrame(frame({ createdAt: undefined }))?.update).toEqual({ kind: "delete" })
        expect(decodePlcExportFrame(frame({ createdAt: "yesterday" }))?.update).toEqual({ kind: "delete" })
    })

    it("plc_operation without verificationMethods.atproto → put null", () => {
        const none = decodePlcExportFrame(frame({}, { verificationMethods: {} }))
        expect(none?.update).toMatchObject({ kind: "put", key: null })
        const missing = decodePlcExportFrame(frame({}, { verificationMethods: undefined }))
        expect(missing?.update).toMatchObject({ kind: "put", key: null })
    })

    it("plc_operation whose atproto value is not a did:key:z… string → delete", () => {
        for (const bad of [5, null, "zKey1", "did:key:", "did:key:f00", "did:web:x"]) {
            const e = decodePlcExportFrame(frame({}, { verificationMethods: { atproto: bad } }))
            expect(e?.update, String(bad)).toEqual({ kind: "delete" })
        }
        const notAMap = decodePlcExportFrame(frame({}, { verificationMethods: "x" }))
        expect(notAMap?.update).toEqual({ kind: "delete" })
    })

    it("legacy create → delete, not a key read from signingKey", () => {
        const e = decodePlcExportFrame(
            frame({}, { type: "create", signingKey: "did:key:zLegacy", verificationMethods: undefined })
        )
        expect(e?.update).toEqual({ kind: "delete" })
    })

    it("plc_tombstone → delete", () => {
        expect(decodePlcExportFrame(frame({}, { type: "plc_tombstone" }))?.update).toEqual({ kind: "delete" })
    })

    it("unknown operation type → delete", () => {
        expect(decodePlcExportFrame(frame({}, { type: "plc_future" }))?.update).toEqual({ kind: "delete" })
    })

    it("carries seq and did from the frame", () => {
        const e = decodePlcExportFrame(frame({ seq: 0, did: "did:plc:zzz" }))
        expect(e).toMatchObject({ seq: 0, did: "did:plc:zzz" })
    })

    it("non-JSON, missing or non-integer seq, missing did, or a non-did:plc did → null", () => {
        expect(decodePlcExportFrame("not json")).toBeNull()
        expect(decodePlcExportFrame("null")).toBeNull()
        expect(decodePlcExportFrame("[]")).toBeNull()
        for (const seq of [undefined, 1.5, -1, "7", Number.MAX_SAFE_INTEGER + 1]) {
            expect(decodePlcExportFrame(frame({ seq })), String(seq)).toBeNull()
        }
        expect(decodePlcExportFrame(frame({ did: undefined }))).toBeNull()
        expect(decodePlcExportFrame(frame({ did: "did:web:example.com" }))).toBeNull()
    })

    it("type other than sequenced_op → null", () => {
        expect(decodePlcExportFrame(frame({ type: "other" }))).toBeNull()
        expect(decodePlcExportFrame(frame({ type: undefined }))).toBeNull()
    })

    it("a captured live sequenced_op frame decodes to its seq, did and key", () => {
        expect(decodePlcExportFrame(LIVE_FRAME)).toEqual({
            seq: 20000001,
            did: "did:plc:2sy7cqhmlt4meg23czfj7faa",
            update: {
                kind: "put",
                key: "zQ3shhLLHJy4jrDPvv2rJFN9iQ4bwYaoW5GucxZGW2j7i8bNM",
                asOfMs: Date.parse("2024-11-14T16:09:41.634Z"),
            },
        })
    })
})

describe("intakePlcEvent (S2)", () => {
    it.todo("unwatched DID → ignored, only the cursor advances, nothing owed")
    it.todo("DID in revs → owes the snapshot re-fetch at its indexed rev and the key update with the cursor")
    it.todo("DID only in pending → owes the key update with the cursor, no extra owe")
    it.todo("permanently deleted DID → ignored")
    it.todo("the re-fetch is owed before the key update and cursor, so a crash between them replays the op")
})

describe("drainKeyUpdates (S3)", () => {
    it.todo("put → cache.put with the key and fetchedAtMs = min(asOfMs, nowMs()), then cleared")
    it.todo("delete → cache.delete, then cleared")
    it.todo("respects limit")
    it.todo("a cache failure leaves the update owed and resolves the count applied so far")
    it.todo("an update replaced during the drain is not cleared")
})

describe("plcCursorAfterClose (S4)", () => {
    it.todo("OutdatedCursor and FutureCursor → reset")
    it.todo("ConsumerTooSlow, an empty reason, or anything else → keep")
})
