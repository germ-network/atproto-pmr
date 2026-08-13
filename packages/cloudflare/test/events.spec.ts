/**
 * The events socket end to end: hibernation accept, backlog drain on
 * connect, ack over the socket, and the "pool notice is the last frame
 * before drained, only if non-empty" ordering property.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    decodeFrame,
    encodeCose,
    type CoseValue,
    type DecodedFrame,
} from "@germ-network/atproto-pmr-core"
import { PMRObject } from "../src/pmr-object"
import type { PMREnv } from "../src/env"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    const id = testEnv.pmrs.idFromName(`events-${counter}`)
    return testEnv.pmrs.get(id)
}

/** Opens the socket and collects frames until (and including) `#drained`. */
async function connectAndDrain(
    stub: DurableObjectStub<PMRObject>
): Promise<{ ws: WebSocket; frames: DecodedFrame[] }> {
    const response = await stub.fetch("https://relay.example/pmr/v1/events", {
        headers: { Upgrade: "websocket" },
    })
    expect(response.status).toBe(101)
    const ws = response.webSocket
    if (ws === null) throw new Error("expected a WebSocket in the 101 response")
    // Must be set before accept(): recent compatibility dates deliver
    // binary frames as Blob rather than ArrayBuffer otherwise — same pitfall
    // germ-service already hit (recipient-registration-class.ts).
    ws.binaryType = "arraybuffer"
    ws.accept()

    const frames: DecodedFrame[] = []
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", (event) => {
            const data = event.data
            const bytes =
                typeof data === "string"
                    ? new TextEncoder().encode(data)
                    : new Uint8Array(data as ArrayBuffer)
            const frame = decodeFrame(bytes)
            frames.push(frame)
            if (frame.type === "drained") resolve()
        })
        ws.addEventListener("error", (e) => reject(e))
    })
    return { ws, frames }
}

function ackFrame(key: string, messageId: string): Uint8Array {
    const header = encodeCose(
        new Map<string, CoseValue>([["op", 1], ["t", "#ack"]])
    )
    const body = encodeCose(
        new Map<string, CoseValue>([["k", key], ["id", messageId]])
    )
    return new Uint8Array([...header, ...body])
}

describe("connect and drain", () => {
    it("delivers everything queued across mailbox kinds, then drained, no pool", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]), 0)
        )
        await inPMR(stub, (pmr) =>
            pmr.append("grant-addr-1", { messageId: "m2", byteLength: 5 }, new Uint8Array([2]), 0)
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hello"))
        await testEnv.messages.put("m2", new TextEncoder().encode("world"))

        const { frames } = await connectAndDrain(stub)
        const deliveries = frames.filter((f) => f.type === "delivery")
        expect(deliveries).toHaveLength(2)
        const byId = new Map(deliveries.map((d) => [d.body.get("id"), d.body]))
        expect(new TextDecoder().decode(byId.get("m1")!.get("m") as Uint8Array)).toBe(
            "hello"
        )
        expect(byId.get("m1")!.get("k")).toBe("did:plc:alice")
        expect(new TextDecoder().decode(byId.get("m2")!.get("m") as Uint8Array)).toBe(
            "world"
        )
        expect(frames.filter((f) => f.type === "pool")).toHaveLength(0)
        expect(frames[frames.length - 1].type).toBe("drained")
    })

    it("sends drained immediately when there is nothing queued", async () => {
        const stub = freshStub()
        const { frames } = await connectAndDrain(stub)
        expect(frames.map((f) => f.type)).toEqual(["drained"])
    })

    it("the pool notice rides out as the LAST frame before drained", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]), 0)
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hi"))
        await inPMR(stub, (pmr) =>
            pmr.appendToPool("did:plc:stranger", { messageId: "p1", byteLength: 1 }, new Uint8Array([9]), 0)
        )

        const { frames } = await connectAndDrain(stub)
        expect(frames.map((f) => f.type)).toEqual(["delivery", "pool", "drained"])
    })
})

describe("ack over the socket", () => {
    it("removes the acked message from its mailbox", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]), 0)
        )
        await testEnv.messages.put("m1", new Uint8Array([1, 2, 3]))

        const { ws } = await connectAndDrain(stub)
        ws.send(ackFrame("did:plc:alice", "m1"))

        // The ack is handled inline in webSocketMessage — no waitUntil to
        // race, so it has landed by the time send() returns to us. Confirm
        // by draining a SECOND connection and seeing nothing left.
        const second = await connectAndDrain(stub)
        expect(second.frames.map((f) => f.type)).toEqual(["drained"])
    })

    it("acking an unknown message is a no-op, not a crash", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send(ackFrame("did:plc:nobody", "nonexistent"))

        // The connection is still alive and usable afterward.
        const second = await connectAndDrain(stub)
        expect(second.frames.map((f) => f.type)).toEqual(["drained"])
    })
})

describe("malformed inbound frames", () => {
    it("garbage bytes do not crash the connection", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]))

        const second = await connectAndDrain(stub)
        expect(second.frames.map((f) => f.type)).toEqual(["drained"])
    })

    it("a text frame is ignored rather than throwing", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send("not a binary frame")

        const second = await connectAndDrain(stub)
        expect(second.frames.map((f) => f.type)).toEqual(["drained"])
    })
})

describe("routing", () => {
    it("refuses a non-upgrade request", async () => {
        const stub = freshStub()
        const response = await stub.fetch("https://relay.example/pmr/v1/events")
        expect(response.status).toBe(426)
    })
})
