/**
 * The PLC export stream as a signal for the signing-key cache and the stored
 * DID documents: decode, intake in the read loop, and the drain that reaches
 * the key cache.
 */
import type { PlcLogIndex } from "../src/plc-log"
import { describe, expect, it } from "vitest"
import { renderPlcDocument, type DidDocument } from "@germ-network/atproto-pmr-core"
import {
    decodePlcExportFrame,
    drainKeyUpdates,
    intakePlcEvent,
    plcCursorAfterClose,
    type PlcExportEvent,
    type SigningKeyUpdate,
} from "../src/plc-export"
import type {
    DidDocumentSink,
    KeyUpdateIndex,
    MonitorIndex,
    OwedKeyUpdate,
    SigningKeyCacheWriter,
} from "../src/storage"

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
        expect(decodePlcExportFrame(frame())).toMatchObject({
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
        expect(decodePlcExportFrame(LIVE_FRAME)).toMatchObject({
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
    const event = (did = "did:plc:abc"): PlcExportEvent => ({
        seq: 9,
        did,
        createdAtMs: 5,
        update,
        change: { kind: "refetch" },
        entry: null,
    })

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

describe("drainKeyUpdates", () => {
    function rig(initial: OwedKeyUpdate[], opts: { failOn?: string; onPut?: () => void } = {}) {
        const owed = new Map(initial.map((o) => [o.did, o]))
        const cleared: string[] = []
        const writes: string[] = []
        const stored = new Map<string, { key: string | null; fetchedAtMs: number }>()
        const index = {
            dueKeyUpdates: async (limit: number) => [...owed.values()].slice(0, limit),
            clearKeyUpdate: async (did: string, version: number) => {
                if (owed.get(did)?.version === version) {
                    owed.delete(did)
                    cleared.push(did)
                }
            },
        } as unknown as KeyUpdateIndex
        const cache: SigningKeyCacheWriter = {
            put: async (did, entry) => {
                if (did === opts.failOn) throw new Error("kv down")
                opts.onPut?.()
                writes.push(`put ${did}`)
                stored.set(did, entry)
            },
            delete: async (did) => {
                if (did === opts.failOn) throw new Error("kv down")
                writes.push(`delete ${did}`)
                stored.delete(did)
            },
        }
        return { owed, cleared, writes, stored, deps: { index, cache, nowMs: () => 1_000 } }
    }
    const put = (did: string, asOfMs: number, version = 1): OwedKeyUpdate => ({
        did,
        update: { kind: "put", key: "zK", asOfMs },
        version,
    })
    const del = (did: string, version = 1): OwedKeyUpdate => ({
        did,
        update: { kind: "delete" },
        version,
    })

    it("put → cache.put with the key and fetchedAtMs = min(asOfMs, nowMs()), then cleared", async () => {
        const r = rig([put("did:plc:a", 400), put("did:plc:b", 5_000)])
        expect(await drainKeyUpdates(r.deps, 10)).toBe(2)
        expect(r.stored.get("did:plc:a")).toEqual({ key: "zK", fetchedAtMs: 400 })
        expect(r.stored.get("did:plc:b")).toEqual({ key: "zK", fetchedAtMs: 1_000 })
        expect(r.owed.size).toBe(0)
    })

    it("delete → cache.delete, then cleared", async () => {
        const r = rig([del("did:plc:a")])
        r.stored.set("did:plc:a", { key: "zOld", fetchedAtMs: 1 })
        expect(await drainKeyUpdates(r.deps, 10)).toBe(1)
        expect(r.writes).toEqual(["delete did:plc:a"])
        expect(r.stored.has("did:plc:a")).toBe(false)
        expect(r.cleared).toEqual(["did:plc:a"])
    })

    it("respects limit", async () => {
        const r = rig([put("did:plc:a", 1), put("did:plc:b", 1), put("did:plc:c", 1)])
        expect(await drainKeyUpdates(r.deps, 2)).toBe(2)
        expect([...r.owed.keys()]).toEqual(["did:plc:c"])
    })

    it("a cache failure leaves the update owed and resolves the count applied so far", async () => {
        const r = rig([put("did:plc:a", 1), put("did:plc:b", 1), put("did:plc:c", 1)], {
            failOn: "did:plc:b",
        })
        expect(await drainKeyUpdates(r.deps, 10)).toBe(1)
        expect([...r.owed.keys()]).toEqual(["did:plc:b", "did:plc:c"])
        expect(r.writes).toEqual(["put did:plc:a"])
    })

    it("an update replaced during the drain is not cleared", async () => {
        const r = rig([put("did:plc:a", 1)], {
            onPut: () => r.owed.set("did:plc:a", del("did:plc:a", 2)),
        })
        await drainKeyUpdates(r.deps, 10)
        expect(r.owed.get("did:plc:a")).toEqual(del("did:plc:a", 2))
    })
})

describe("plcCursorAfterClose", () => {
    it("OutdatedCursor and FutureCursor → reset", () => {
        expect(plcCursorAfterClose("OutdatedCursor")).toBe("reset")
        expect(plcCursorAfterClose("FutureCursor")).toBe("reset")
    })

    it("ConsumerTooSlow, an empty reason, or anything else → keep", () => {
        for (const reason of ["ConsumerTooSlow", "", "Going Away", "outdatedcursor"]) {
            expect(plcCursorAfterClose(reason), reason).toBe("keep")
        }
    })
})

/** A live `sequenced_op` entry from plc.directory's `/export`, the shape its stream sends. */
const OP_DID = "did:plc:5jp6kvueqebbcuf77rd5sqtj"
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

function opFrame(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        did: OP_DID,
        cid: "bafyreihkl7svnbebaiivbp74i7mue2kqmllc2ygtmlnrnhmf2y5im5qura",
        seq: 1000001,
        createdAt: "2023-09-04T02:25:42.341Z",
        operation: OPERATION,
        type: "sequenced_op",
        ...overrides,
    })
}

describe("decodePlcExportFrame: the stored document change", () => {
    it("a plc_operation decodes to render, with the document renderPlcDocument gives for it", () => {
        const event = decodePlcExportFrame(opFrame())
        expect(event?.change).toEqual({
            kind: "render",
            document: renderPlcDocument(OP_DID, OPERATION),
        })
        expect(event?.change.kind === "render" && event.change.document.id).toBe(OP_DID)
    })

    it("a plc_tombstone decodes to tombstone", () => {
        const event = decodePlcExportFrame(
            opFrame({ operation: { type: "plc_tombstone", prev: "bafy", sig: "x" } })
        )
        expect(event?.change).toEqual({ kind: "tombstone" })
    })

    it("a legacy create decodes to refetch", () => {
        const event = decodePlcExportFrame(opFrame({ operation: { ...OPERATION, type: "create" } }))
        expect(event?.change).toEqual({ kind: "refetch" })
    })

    it("an unknown operation type decodes to refetch", () => {
        const unknown = decodePlcExportFrame(
            opFrame({ operation: { ...OPERATION, type: "plc_something_new" } })
        )
        expect(unknown?.change).toEqual({ kind: "refetch" })
        expect(decodePlcExportFrame(opFrame({ operation: {} }))?.change).toEqual({ kind: "refetch" })
        expect(decodePlcExportFrame(opFrame({ operation: "op" }))?.change).toEqual({ kind: "refetch" })
    })

    it("a plc_operation that does not render decodes to refetch", () => {
        const event = decodePlcExportFrame(opFrame({ operation: { ...OPERATION, services: {} } }))
        expect(event?.change).toEqual({ kind: "refetch" })
    })

    it("keeps createdAt as createdAtMs", () => {
        expect(decodePlcExportFrame(opFrame())).toMatchObject({
            seq: 1000001,
            did: OP_DID,
            createdAtMs: Date.parse("2023-09-04T02:25:42.341Z"),
        })
    })

    it("an unparseable or missing createdAt gives no createdAtMs and a refetch, not a render", () => {
        for (const createdAt of ["yesterday", "", 5, null]) {
            const event = decodePlcExportFrame(opFrame({ createdAt }))
            expect(event, String(createdAt)).toMatchObject({ createdAtMs: null, change: { kind: "refetch" } })
        }
        const { createdAt: _, ...none } = JSON.parse(opFrame())
        expect(decodePlcExportFrame(JSON.stringify(none))).toMatchObject({
            createdAtMs: null,
            change: { kind: "refetch" },
        })
    })
})

describe("intakePlcEvent: the stored document", () => {
    const AT = 1_693_000_000_000

    /** In-memory index and sink that log every call, in order. */
    function fakes(opts: {
        watched?: boolean
        deleted?: boolean
        rev?: string | null
        failRecord?: boolean
        failOwe?: boolean
        failKey?: boolean
    } = {}) {
        const log: string[] = []
        const calls = {
            recorded: [] as Array<[string, unknown, number]>,
            stale: [] as Array<[string, number]>,
            owed: [] as Array<[string, string]>,
            key: [] as Array<[string, number | undefined, number | undefined]>,
            cursor: [] as Array<[number, number | undefined]>,
        }
        const index = {
            isWatched: async () => opts.watched ?? true,
            isDeleted: async () => opts.deleted ?? false,
            revOf: async () => (opts.rev === undefined ? "3m1" : opts.rev),
            owe: async (did: string, rev: string) => {
                log.push("owe")
                if (opts.failOwe) throw new Error("sqlite down")
                calls.owed.push([did, rev])
            },
            oweKeyUpdate: async (did: string, _u: unknown, seq?: number, createdAt?: number) => {
                log.push("key")
                if (opts.failKey) throw new Error("sqlite down")
                calls.key.push([did, seq, createdAt])
            },
            advancePlcCursor: async (seq: number, createdAt?: number) => {
                log.push("cursor")
                calls.cursor.push([seq, createdAt])
            },
        } as unknown as MonitorIndex & KeyUpdateIndex
        const sink: DidDocumentSink = {
            recordDidDocument: async (did, document, asOfMs) => {
                log.push("record")
                if (opts.failRecord) throw new Error("sqlite down")
                calls.recorded.push([did, document, asOfMs])
            },
            markDidDocumentStale: async (did, asOfMs) => {
                log.push("stale")
                calls.stale.push([did, asOfMs])
            },
        }
        return { index, sink, calls, log }
    }
    const DID_ = "did:plc:abc"
    const event = (
        change: PlcExportEvent["change"],
        createdAtMs: number | null = AT
    ): PlcExportEvent => ({
        seq: 42,
        did: DID_,
        createdAtMs,
        update: { kind: "delete" },
        entry: null,
        change,
    })
    const document: DidDocument = { id: DID_ }
    const RENDER = { kind: "render", document } as const

    it("an unwatched DID writes no document and only advances the cursor, with the op's createdAt", async () => {
        const f = fakes({ watched: false })
        expect(await intakePlcEvent(f.index, event(RENDER), f.sink)).toBe("ignored")
        expect(f.log).toEqual(["cursor"])
        expect(f.calls.cursor).toEqual([[42, AT]])
    })

    it("a permanently deleted DID's document still follows the stream, but nothing is owed and the cursor advances with its createdAt", async () => {
        const f = fakes({ watched: false, deleted: true })
        expect(await intakePlcEvent(f.index, event(RENDER), f.sink)).toBe("ignored")
        expect(f.calls.recorded).toEqual([[DID_, document, AT]])
        expect(f.calls.owed).toEqual([])
        expect(f.calls.key).toEqual([])
        expect(f.log).toEqual(["record", "cursor"])
        expect(f.calls.cursor).toEqual([[42, AT]])
        const g = fakes({ watched: false, deleted: true })
        await intakePlcEvent(g.index, event({ kind: "refetch" }), g.sink)
        expect(g.calls.stale).toEqual([[DID_, AT]])
    })

    it("a DID neither watched nor deleted gets no document write", async () => {
        const f = fakes({ watched: false, deleted: false })
        await intakePlcEvent(f.index, event(RENDER), f.sink)
        expect(f.log).toEqual(["cursor"])
    })

    it("a watched DID's render is stored as of the op's createdAt", async () => {
        const f = fakes()
        expect(await intakePlcEvent(f.index, event(RENDER), f.sink)).toBe("owed")
        expect(f.calls.recorded).toEqual([[DID_, document, AT]])
        expect(f.calls.stale).toEqual([])
    })

    it("a watched DID's tombstone stores a null document", async () => {
        const f = fakes()
        await intakePlcEvent(f.index, event({ kind: "tombstone" }), f.sink)
        expect(f.calls.recorded).toEqual([[DID_, null, AT]])
    })

    it("a watched DID's refetch marks the stored document stale as of the op's createdAt", async () => {
        const f = fakes()
        await intakePlcEvent(f.index, event({ kind: "refetch" }), f.sink)
        expect(f.calls.stale).toEqual([[DID_, AT]])
        expect(f.calls.recorded).toEqual([])
    })

    it("an op with no createdAt marks the document stale as of its arrival", async () => {
        const f = fakes()
        const before = Date.now()
        await intakePlcEvent(f.index, event({ kind: "refetch" }, null), f.sink)
        const [, asOf] = f.calls.stale[0]!
        expect(asOf).toBeGreaterThanOrEqual(before)
        expect(asOf).toBeLessThanOrEqual(Date.now())
        expect(f.calls.key).toEqual([[DID_, 42, undefined]])
    })

    it("the document is written before the re-fetch is owed and the key update with the cursor", async () => {
        const f = fakes()
        await intakePlcEvent(f.index, event(RENDER), f.sink)
        expect(f.log).toEqual(["record", "owe", "key"])
        expect(f.calls.key).toEqual([[DID_, 42, AT]])
        const g = fakes()
        await intakePlcEvent(g.index, event({ kind: "refetch" }), g.sink)
        expect(g.log).toEqual(["stale", "owe", "key"])
    })

    it("a watched DID that is only owed a fetch stores the document and owes no re-fetch", async () => {
        const f = fakes({ rev: null })
        await intakePlcEvent(f.index, event(RENDER), f.sink)
        expect(f.calls.recorded).toHaveLength(1)
        expect(f.calls.owed).toEqual([])
    })

    it("a failed document write owes nothing and leaves the cursor where it was", async () => {
        const f = fakes({ failRecord: true })
        await expect(intakePlcEvent(f.index, event(RENDER), f.sink)).rejects.toThrow("sqlite down")
        expect(f.log).toEqual(["record"])
    })

    it("a failed re-fetch obligation leaves the key update and the cursor unwritten", async () => {
        const f = fakes({ failOwe: true })
        await expect(intakePlcEvent(f.index, event(RENDER), f.sink)).rejects.toThrow("sqlite down")
        expect(f.calls.key).toEqual([])
    })

    it("without a document sink the stored documents are left alone", async () => {
        const f = fakes()
        expect(await intakePlcEvent(f.index, event(RENDER))).toBe("owed")
        expect(f.log).toEqual(["owe", "key"])
    })
})

describe("PLC log entries from the stream", () => {
    const frame = (over: Record<string, unknown> = {}) =>
        JSON.stringify({
            type: "sequenced_op",
            seq: 7,
            did: "did:plc:abc",
            cid: "bafyreicid",
            createdAt: "2026-10-13T00:00:00.071Z",
            operation: { type: "plc_operation", prev: "bafyreiprev", sig: "SIG", rotationKeys: [] },
            ...over,
        })

    it("a frame yields its entry: cid, the operation with its sig, createdAt, never nullified", () => {
        expect(decodePlcExportFrame(frame())?.entry).toEqual({
            cid: "bafyreicid",
            operation: { type: "plc_operation", prev: "bafyreiprev", sig: "SIG", rotationKeys: [] },
            createdAtMs: Date.parse("2026-10-13T00:00:00.071Z"),
            nullified: false,
        })
    })

    it("a frame without a cid, an object operation or a usable createdAt yields no entry", () => {
        for (const over of [
            { cid: undefined },
            { operation: "op" },
            { operation: [] },
            { createdAt: undefined },
            { createdAt: "yesterday" },
        ]) {
            expect(decodePlcExportFrame(frame(over))?.entry, JSON.stringify(over)).toBeNull()
        }
    })

    function intake(watched: boolean) {
        const calls: string[] = []
        const index = {
            isWatched: async () => watched,
            isDeleted: async () => false,
            advancePlcCursor: async () => {},
            revOf: async () => null,
            owe: async () => {},
            oweKeyUpdate: async () => {},
        } as unknown as MonitorIndex & KeyUpdateIndex
        const plcLogs = {
            intakePlcLogEntry: async (did: string, entry: { cid: string }) => {
                calls.push(`entry ${did} ${entry.cid}`)
            },
            owePlcLog: async (did: string) => {
                calls.push(`owe ${did}`)
            },
        } as unknown as PlcLogIndex
        return { index, plcLogs, calls }
    }

    it("a watched DID's entry goes to its retained log; one with no entry owes a fetch", async () => {
        const w = intake(true)
        await intakePlcEvent(w.index, decodePlcExportFrame(frame())!, undefined, w.plcLogs)
        await intakePlcEvent(w.index, decodePlcExportFrame(frame({ cid: undefined }))!, undefined, w.plcLogs)
        expect(w.calls).toEqual(["entry did:plc:abc bafyreicid", "owe did:plc:abc"])
    })

    it("a DID that is not watched gives its log nothing", async () => {
        const w = intake(false)
        await intakePlcEvent(w.index, decodePlcExportFrame(frame())!, undefined, w.plcLogs)
        expect(w.calls).toEqual([])
    })
})
