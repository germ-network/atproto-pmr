/**
 * The events socket end to end: hibernation accept, backlog drain on
 * connect, ack over the socket, and the "pool notice is the last frame
 * before caughtUp, only if non-empty" ordering property.
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

/** Opens the socket and collects frames until (and including) `#caughtUp`. */
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
            if (frame.type === "caughtUp") resolve()
        })
        ws.addEventListener("error", (e) => reject(e))
    })
    return { ws, frames }
}

/** Frame types after the leading `#capabilities`, which every drain sends. */
function typesAfterCapabilities(frames: DecodedFrame[]): string[] {
    expect(frames[0].type).toBe("capabilities")
    return frames.slice(1).map((f) => f.type)
}

/**
 * Connect and return just the leading `#capabilities` frame, optionally
 * with env vars overridden on the live instance first.
 *
 * The override replaces the instance's `env` rather than mutating it —
 * `env` is shared, and mutating it would leak into every later test. Same
 * reach-in idiom as `withSyntheticBehavior`, and contained here for the
 * same reason.
 */
async function drainOnce(
    stub: DurableObjectStub<PMRObject>,
    envOverride?: Record<string, string>
): Promise<DecodedFrame> {
    if (envOverride !== undefined) {
        await inPMR(stub, (pmr) => {
            const held = pmr as unknown as { env: PMREnv }
            held.env = { ...held.env, ...envOverride }
        })
    }
    const { frames } = await connectAndDrain(stub)
    return frames[0]
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
    it("delivers everything queued across mailbox kinds, then caughtUp, no pool", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]), 0)
        )
        await inPMR(stub, (pmr) =>
            pmr.append("grant:addr-1", { messageId: "m2", byteLength: 5 }, new Uint8Array([2]), 0)
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
        expect(frames[frames.length - 1].type).toBe("caughtUp")
    })

    it("sends caughtUp immediately when there is nothing queued", async () => {
        const stub = freshStub()
        const { frames } = await connectAndDrain(stub)
        expect(typesAfterCapabilities(frames)).toEqual(["caughtUp"])
    })

    it("the pool notice rides out as the LAST frame before caughtUp", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]), 0)
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hi"))
        await inPMR(stub, (pmr) =>
            pmr.appendToPool("did:plc:stranger", { messageId: "p1", byteLength: 1 }, new Uint8Array([9]), 0)
        )

        const { frames } = await connectAndDrain(stub)
        expect(typesAfterCapabilities(frames)).toEqual(["delivery", "pool", "caughtUp"])
    })
})

describe("the capabilities frame", () => {
    it("reports the deployment's grant lifecycle, and nothing else", async () => {
        const stub = freshStub()
        const { frames } = await connectAndDrain(stub)
        const c = frames[0]
        expect(c.type).toBe("capabilities")
        // wrangler.test.toml sets GRANT_LIFECYCLE = "active".
        expect(c.body.get("gr")).toBe("active")
        // Mailbox operation is not declared, so nothing reports on it: a
        // relay serves both kinds or is not a relay.
        expect([...c.body.keys()]).toEqual(["gr"])
    })

    it("reports a drain as absent once this registration holds no live grant", async () => {
        // The per-registration refinement: deployment-wide policy says
        // draining, but a drain ends per-user, so a client with nothing
        // outstanding is told absent rather than left waiting on a state
        // that will never change for them.
        const stub = freshStub()

        const before = await drainOnce(stub, { GRANT_LIFECYCLE: "draining" })
        expect(before.body.get("gr")).toBe("absent")

        const future = Math.floor(Date.now() / 1000) + 3600
        await inPMR(stub, (pmr) =>
            pmr.issueGrant("addr-live", new Uint8Array(32), future)
        )
        const after = await drainOnce(stub, { GRANT_LIFECYCLE: "draining" })
        expect(after.body.get("gr")).toBe("draining")
    })

    it("an expired grant does not hold a drain open", async () => {
        const stub = freshStub()
        const past = Math.floor(Date.now() / 1000) - 1
        await inPMR(stub, (pmr) =>
            pmr.issueGrant("addr-expired", new Uint8Array(32), past)
        )
        expect((await drainOnce(stub, { GRANT_LIFECYCLE: "draining" })).body.get("gr")).toBe("absent")
    })

    it("re-sends unsolicited when invalidating the last grant ends a drain", async () => {
        // The one transition this object can cause rather than merely
        // observe, so it is the one it announces without a reconnect.
        const stub = freshStub()
        const future = Math.floor(Date.now() / 1000) + 3600
        await inPMR(stub, (pmr) =>
            pmr.issueGrant("addr-live", new Uint8Array(32), future)
        )
        expect(
            (await drainOnce(stub, { GRANT_LIFECYCLE: "draining" })).body.get("gr")
        ).toBe("draining")

        // Stay attached and watch for a frame arriving with no request.
        const response = await stub.fetch("https://relay.example/pmr/v1/events", {
            headers: { Upgrade: "websocket" },
        })
        const ws = response.webSocket
        if (ws === null) throw new Error("expected a WebSocket")
        ws.binaryType = "arraybuffer"
        ws.accept()

        const unsolicited = new Promise<DecodedFrame>((resolve) => {
            let connectBurstOver = false
            ws.addEventListener("message", (event) => {
                const f = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
                if (f.type === "caughtUp") {
                    connectBurstOver = true
                    return
                }
                if (connectBurstOver && f.type === "capabilities") resolve(f)
            })
        })

        await inPMR(stub, (pmr) => pmr.invalidateGrant("addr-live"))
        expect((await unsolicited).body.get("gr")).toBe("absent")
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

        // `send` only puts bytes on the wire; the DO's webSocketMessage
        // handler runs on the other side of it, so nothing orders this
        // against the ack landing. Poll the outcome rather than assume.
        await expect
            .poll(() => inPMR(stub, (pmr) => pmr.list("did:plc:alice", 10)))
            .toEqual([])
    })

    it("acking an unknown message is a no-op, not a crash", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send(ackFrame("did:plc:nobody", "nonexistent"))

        // The connection is still alive and usable afterward.
        const second = await connectAndDrain(stub)
        expect(typesAfterCapabilities(second.frames)).toEqual(["caughtUp"])
    })
})

describe("malformed inbound frames", () => {
    it("garbage bytes do not crash the connection", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]))

        const second = await connectAndDrain(stub)
        expect(typesAfterCapabilities(second.frames)).toEqual(["caughtUp"])
    })

    it("a text frame is ignored rather than throwing", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        ws.send("not a binary frame")

        const second = await connectAndDrain(stub)
        expect(typesAfterCapabilities(second.frames)).toEqual(["caughtUp"])
    })
})

describe("routing", () => {
    it("refuses a non-upgrade request", async () => {
        const stub = freshStub()
        const response = await stub.fetch("https://relay.example/pmr/v1/events")
        expect(response.status).toBe(426)
    })
})
