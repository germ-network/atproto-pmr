/**
 * The PLC export stream as a signing-key cache signal: decode, intake in the
 * read loop, and the drain that reaches the cache.
 */
import { describe, expect, it } from "vitest"
import {
    decodePlcExportFrame,
    intakePlcEvent,
    type PlcExportEvent,
    type SigningKeyUpdate,
} from "../src/plc-export"
import type { KeyUpdateIndex, MonitorIndex } from "../src/storage"

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

describe("intakePlcEvent", () => {
    function fake(opts: { revs?: Record<string, string>; pending?: string[]; deleted?: string[] } = {}) {
        const revs = new Map(Object.entries(opts.revs ?? {}))
        const pending = new Set(opts.pending ?? [])
        const deleted = new Set(opts.deleted ?? [])
        const calls: string[] = []
        const owed: Array<{ did: string; update: SigningKeyUpdate; plcSeq?: number }> = []
        const index = {
            isWatched: async (did: string) =>
                !deleted.has(did) && (revs.has(did) || pending.has(did)),
            revOf: async (did: string) => revs.get(did) ?? null,
            owe: async (did: string, rev: string) => void calls.push(`owe ${did} ${rev}`),
            advancePlcCursor: async (seq: number) => void calls.push(`cursor ${seq}`),
            oweKeyUpdate: async (did: string, update: SigningKeyUpdate, plcSeq?: number) => {
                calls.push(`key ${did}`)
                owed.push({ did, update, plcSeq })
            },
        }
        return { index: index as unknown as MonitorIndex & KeyUpdateIndex, calls, owed }
    }
    const update: SigningKeyUpdate = { kind: "put", key: "zK", asOfMs: 5 }
    const event = (did = "did:plc:abc"): PlcExportEvent => ({ seq: 9, did, update })

    it("unwatched DID → ignored, only the cursor advances, nothing owed", async () => {
        const f = fake()
        expect(await intakePlcEvent(f.index, event())).toBe("ignored")
        expect(f.calls).toEqual(["cursor 9"])
        expect(f.owed).toEqual([])
    })

    it("DID in revs → owes the snapshot re-fetch at its indexed rev and the key update with the cursor", async () => {
        const f = fake({ revs: { "did:plc:abc": "3m1" } })
        expect(await intakePlcEvent(f.index, event())).toBe("owed")
        expect(f.owed).toEqual([{ did: "did:plc:abc", update, plcSeq: 9 }])
        expect(f.calls).toContain("owe did:plc:abc 3m1")
        expect(f.calls).not.toContain("cursor 9")
    })

    it("DID only in pending → owes the key update with the cursor, no extra owe", async () => {
        const f = fake({ pending: ["did:plc:abc"] })
        expect(await intakePlcEvent(f.index, event())).toBe("owed")
        expect(f.owed).toEqual([{ did: "did:plc:abc", update, plcSeq: 9 }])
        expect(f.calls.filter((c) => c.startsWith("owe "))).toEqual([])
    })

    it("permanently deleted DID → ignored", async () => {
        const f = fake({ revs: { "did:plc:abc": "3m1" }, deleted: ["did:plc:abc"] })
        expect(await intakePlcEvent(f.index, event())).toBe("ignored")
        expect(f.owed).toEqual([])
        expect(f.calls).toEqual(["cursor 9"])
    })

    it("the re-fetch is owed before the key update and cursor, so a crash between them replays the op", async () => {
        const f = fake({ revs: { "did:plc:abc": "3m1" } })
        await intakePlcEvent(f.index, event())
        expect(f.calls).toEqual(["owe did:plc:abc 3m1", "key did:plc:abc"])
    })
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
