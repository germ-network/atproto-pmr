/**
 * The events socket's frame protocol: header+body framing, and the
 * drain-backlog orchestration against an in-memory `PMRStore`/`BodyStore`.
 */
import { describe, expect, it } from "vitest"
import { decodeCoseSequence, encodeCose, type CoseValue } from "../src/cose/cbor"
import {
    decodeAckFrame,
    decodeFrame,
    drainBacklog,
    encodeCapabilitiesFrame,
    encodeCaughtUpFrame,
    encodeDeliveryFrame,
    encodePoolFrame,
    handleAckFrame,
    type EffectiveCapabilities,
    type EventsDeps,
} from "../src/events"
import type {
    BodyStore,
    MailboxSnapshot,
    MessageRef,
    OpenMailboxesPage,
    PMRStore,
    PoolSender,
} from "../src/storage"

const DC = "bafyreibnx7iqeihelssyae2kritsro2rylzgs5i6ul4ugtp6ycw5tyft7q"
// sd/dc fixture agreed with the client lane; the frame hex is this encoder's output, shared so both lanes pin the same bytes.
const VECTOR_DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const VECTOR_FRAME_HEX =
    "a26174692364656c6976657279626f7001a5616b6d6469643a706c633a616c696365616d43010203626463783b62616679726569646a686866337a796e6e76337175676968706d683735376a3775686578646b36326b6d743462676a71777361636a693735643465626964626d3162736478206469643a706c633a73656e646572303030303030303030303030303030303030"
const bytesToHex = (b: Uint8Array) =>
    [...b].map((x) => x.toString(16).padStart(2, "0")).join("")

function ref(id: string, hint?: MessageRef["hint"]): MessageRef {
    return { messageId: id, byteLength: 5, hint }
}

describe("frame encode/decode", () => {
    it("a delivery frame round-trips key, id, and message bytes", () => {
        const frame = encodeDeliveryFrame("did:plc:alice", ref("m1"), new TextEncoder().encode("hi"))
        const decoded = decodeFrame(frame)
        expect(decoded.type).toBe("delivery")
        expect(decoded.body.get("k")).toBe("did:plc:alice")
        expect(decoded.body.get("id")).toBe("m1")
        expect(decoded.body.get("m")).toEqual(new TextEncoder().encode("hi"))
        expect(decoded.body.has("sd")).toBe(false)
        expect(decoded.body.has("dc")).toBe(false)
    })

    it("a delivery frame for a pair-mailbox entry carries the verification hint", () => {
        const frame = encodeDeliveryFrame(
            "did:plc:alice",
            ref("m1", { senderDID: "did:plc:sender", declarationCID: DC }),
            new Uint8Array([1])
        )
        const decoded = decodeFrame(frame)
        expect(decoded.body.get("sd")).toBe("did:plc:sender")
        expect(decoded.body.get("dc")).toBe(DC)
    })

    it("the pool and caughtUp frames carry empty bodies", () => {
        expect(decodeFrame(encodePoolFrame())).toEqual({ type: "pool", body: new Map() })
        expect(decodeFrame(encodeCaughtUpFrame())).toEqual({
            type: "caughtUp",
            body: new Map(),
        })
    })

    it("a capabilities frame round-trips each grant state", () => {
        for (const grant of ["active", "draining", "absent"] as const) {
            const decoded = decodeFrame(encodeCapabilitiesFrame({ grant }))
            expect(decoded.type).toBe("capabilities")
            expect(decoded.body.get("gr")).toBe(grant)
        }
    })

    it("is two concatenated top-level canonical CBOR values, not one wrapped structure", () => {
        // Proves the wire shape is header-then-body concatenation (atproto's
        // convention), not e.g. a single [header, body] array — decoded
        // generically with the sequence decoder rather than this module's
        // own `decodeFrame`, so the assertion is independent of it.
        const frame = encodePoolFrame()
        const values = decodeCoseSequence(frame)
        expect(values).toHaveLength(2)
        const [header, body] = values as [Map<string, CoseValue>, Map<string, CoseValue>]
        expect(header.get("op")).toBe(1)
        expect(header.get("t")).toBe("#pool")
        expect(body.size).toBe(0)
    })

    it("rejects a frame with a wrong op", () => {
        const bad = new Uint8Array([
            ...encodeCose(new Map<string, CoseValue>([["op", -1], ["t", "#pool"]])),
            ...encodeCose(new Map()),
        ])
        expect(() => decodeFrame(bad)).toThrow()
    })

    it("rejects a frame with only a header and no body", () => {
        const headerOnly = encodeCose(
            new Map<string, CoseValue>([["op", 1], ["t", "#pool"]])
        )
        expect(() => decodeFrame(headerOnly)).toThrow()
    })

    it("rejects trailing garbage after a valid header+body pair", () => {
        const withExtra = new Uint8Array([...encodePoolFrame(), 0x00])
        expect(() => decodeFrame(withExtra)).toThrow()
    })

    it("rejects a non-canonical (re-encodable-differently) frame", () => {
        // A duplicate map key is not canonical CBOR — decode must reject it,
        // matching the deterministic-CBOR discipline used everywhere else.
        const garbage = new Uint8Array([0xa1, 0x61, 0x61, 0x01, 0xa1, 0x61, 0x61, 0x01])
        expect(() => decodeFrame(garbage)).toThrow()
    })
})

describe("ack frame", () => {
    it("round-trips key and messageId", () => {
        const frame = encodeCose(
            new Map<string, CoseValue>([["op", 1], ["t", "#ack"]])
        )
        const body = encodeCose(
            new Map<string, CoseValue>([["k", "did:plc:alice"], ["id", "m1"]])
        )
        const combined = new Uint8Array([...frame, ...body])
        expect(decodeAckFrame(combined)).toEqual({ key: "did:plc:alice", messageId: "m1" })
    })

    it("rejects a frame of the wrong type", () => {
        expect(() => decodeAckFrame(encodePoolFrame())).toThrow()
    })
})

/** A minimal in-memory PMRStore + BodyStore — only what drainBacklog touches. */
function world() {
    const mailboxes = new Map<string, MessageRef[]>()
    const bodies = new Map<string, Uint8Array>()
    const pool: PoolSender[] = []
    const removed: { key: string; messageId: string }[] = []

    const store = {
        async openMailboxes(cursor: string | null, limit: number): Promise<OpenMailboxesPage> {
            const keys = [...mailboxes.keys()].sort()
            const startIndex = cursor === null ? 0 : keys.indexOf(cursor) + 1
            const page = keys.slice(startIndex, startIndex + limit)
            const entries: MailboxSnapshot[] = page.map((key) => ({
                key,
                messages: mailboxes.get(key)!,
            }))
            const nextCursor =
                startIndex + limit < keys.length ? page[page.length - 1] : null
            return { entries, nextCursor }
        },
        async poolSenders() {
            return pool
        },
        async remove(key: string, messageId: string) {
            removed.push({ key, messageId })
            const queue = mailboxes.get(key)
            if (queue === undefined) return
            mailboxes.set(
                key,
                queue.filter((r) => r.messageId !== messageId)
            )
        },
    } as unknown as PMRStore

    const bodyStore: BodyStore = {
        async putBody(id, bytes) {
            bodies.set(id, bytes)
        },
        async getBody(id) {
            return bodies.get(id) ?? null
        },
        async deleteBody(id) {
            bodies.delete(id)
        },
    }

    return { mailboxes, bodies, pool, removed, store, bodyStore }
}

const ALL_ACTIVE: EffectiveCapabilities = { grant: "active" }

function deps(w: ReturnType<typeof world>): EventsDeps {
    return { store: w.store, bodies: w.bodyStore }
}

/** Frame types after the leading `#capabilities`, which every drain sends. */
function typesAfterCapabilities(frames: Uint8Array[]): string[] {
    const types = frames.map((f) => decodeFrame(f).type)
    expect(types[0]).toBe("capabilities")
    return types.slice(1)
}

describe("drainBacklog", () => {
    it("delivers everything queued, across mailboxes, then caughtUp — no pool", async () => {
        const w = world()
        w.mailboxes.set("did:plc:alice", [ref("m1")])
        w.mailboxes.set("grant:addr", [ref("m2")])
        w.bodies.set("m1", new TextEncoder().encode("one"))
        w.bodies.set("m2", new TextEncoder().encode("two"))

        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), ALL_ACTIVE, (f) => frames.push(f))

        const decoded = frames.map(decodeFrame)
        expect(decoded.filter((d) => d.type === "delivery")).toHaveLength(2)
        expect(decoded.filter((d) => d.type === "pool")).toHaveLength(0)
        expect(decoded[decoded.length - 1].type).toBe("caughtUp")
    })

    it("sends the pool notice as the LAST frame before caughtUp, only when the pool is non-empty", async () => {
        const w = world()
        w.mailboxes.set("did:plc:alice", [ref("m1")])
        w.bodies.set("m1", new Uint8Array([1]))
        w.pool.push({ did: "did:plc:stranger", count: 1 })

        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), ALL_ACTIVE, (f) => frames.push(f))

        expect(typesAfterCapabilities(frames)).toEqual([
            "delivery",
            "pool",
            "caughtUp",
        ])
    })

    it("always sends caughtUp, even with nothing queued and no pool", async () => {
        const w = world()
        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), ALL_ACTIVE, (f) => frames.push(f))
        expect(typesAfterCapabilities(frames)).toEqual(["caughtUp"])
    })

    it("leads with capabilities, before any delivery", async () => {
        // A client that does not yet know grants are draining cannot tell
        // "nothing queued" from "these addresses are winding down".
        const w = world()
        w.mailboxes.set("did:plc:alice", [ref("m1")])
        w.bodies.set("m1", new Uint8Array([1]))

        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), { grant: "draining" }, (f) =>
            frames.push(f)
        )

        const first = decodeFrame(frames[0])
        expect(first.type).toBe("capabilities")
        expect(first.body.get("gr")).toBe("draining")
    })

    it("skips a ref whose body is missing rather than failing the whole drain", async () => {
        const w = world()
        w.mailboxes.set("did:plc:alice", [ref("m1"), ref("m2")])
        w.bodies.set("m2", new Uint8Array([2])) // m1's body is missing

        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), ALL_ACTIVE, (f) => frames.push(f))
        const decoded = frames.map(decodeFrame)
        const delivered = decoded.filter((d) => d.type === "delivery")
        expect(delivered).toHaveLength(1)
        expect(delivered[0].body.get("id")).toBe("m2")
    })

    it("pages through more mailboxes than fit in one page", async () => {
        const w = world()
        for (let i = 0; i < 5; i++) {
            w.mailboxes.set(`did:plc:m${i}`, [ref(`msg${i}`)])
            w.bodies.set(`msg${i}`, new Uint8Array([i]))
        }
        const frames: Uint8Array[] = []
        await drainBacklog(deps(w), ALL_ACTIVE, (f) => frames.push(f), 2)
        const delivered = frames.map(decodeFrame).filter((d) => d.type === "delivery")
        expect(delivered).toHaveLength(5)
    })
})

describe("handleAckFrame", () => {
    it("removes the acked message from its mailbox", async () => {
        const w = world()
        w.mailboxes.set("did:plc:alice", [ref("m1")])
        const frame = encodeCose(
            new Map<string, CoseValue>([["op", 1], ["t", "#ack"]])
        )
        const body = encodeCose(
            new Map<string, CoseValue>([["k", "did:plc:alice"], ["id", "m1"]])
        )
        await handleAckFrame(deps(w), new Uint8Array([...frame, ...body]))
        expect(w.removed).toEqual([{ key: "did:plc:alice", messageId: "m1" }])
    })
})

describe("sender hint on the wire", () => {
    it("a hinted ref emits exactly sd and dc (the declaration record CID) and no kt", () => {
        const decoded = decodeFrame(
            encodeDeliveryFrame(
                "did:plc:alice",
                ref("m1", { senderDID: "did:plc:sender000000000000000000", declarationCID: DC }),
                new Uint8Array([1])
            )
        )
        expect([...decoded.body.keys()].sort()).toEqual(["dc", "id", "k", "m", "sd"])
        expect(decoded.body.get("dc")).toBe(DC)
    })

    it("an unhinted ref emits neither sd nor dc", () => {
        const decoded = decodeFrame(
            encodeDeliveryFrame("did:plc:alice", ref("m1"), new Uint8Array([1]))
        )
        expect(decoded.body.has("sd")).toBe(false)
        expect(decoded.body.has("dc")).toBe(false)
    })

    it("a hint without a declarationCID (stored before dc existed) emits no hint at all", () => {
        const legacy = { senderDID: "did:plc:sender", anchorKeyThumbprint: "abcd" } as never
        const decoded = decodeFrame(
            encodeDeliveryFrame("did:plc:alice", ref("m1", legacy), new Uint8Array([1]))
        )
        expect([...decoded.body.keys()].sort()).toEqual(["id", "k", "m"])
    })

    it("pins the delivery frame bytes for the client lane's sd/dc fixture", () => {
        const frame = encodeDeliveryFrame(
            "did:plc:alice",
            ref("m1", { senderDID: "did:plc:sender000000000000000000", declarationCID: VECTOR_DC }),
            new Uint8Array([1, 2, 3])
        )
        const decoded = decodeFrame(frame)
        expect(decoded.body.get("sd")).toBe("did:plc:sender000000000000000000")
        expect(decoded.body.get("dc")).toBe(VECTOR_DC)
        expect(decoded.body.get("k")).toBe("did:plc:alice")
        expect(decoded.body.get("id")).toBe("m1")
        expect(decoded.body.get("m")).toEqual(new Uint8Array([1, 2, 3]))
        expect(bytesToHex(frame)).toBe(VECTOR_FRAME_HEX)
    })
})
