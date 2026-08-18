/**
 * The events socket end to end: hibernation accept, backlog drain on
 * connect, ack over the socket, and the "pool notice is the last frame
 * before caughtUp, only if non-empty" ordering property.
 */
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
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

describe("live push", () => {
    it("append() does no socket I/O — deliverLive is the only push", async () => {
        // T1. A raw post-append() snapshot would be race-prone (frame
        // delivery to the listener is itself async), so this counts total
        // delivered frames after BOTH calls settle: if append() had also
        // pushed, the count would be 2, not 1.
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        const delivered: DecodedFrame[] = []
        ws.addEventListener("message", (event) => {
            delivered.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })

        const ref = { messageId: "m1", byteLength: 5 }
        await inPMR(stub, (pmr) =>
            pmr.append("did:plc:alice", ref, new Uint8Array([1]), 0)
        )
        await inPMR(stub, (pmr) =>
            pmr.deliverLive("did:plc:alice", ref, new TextEncoder().encode("hello"))
        )
        await expect.poll(() => delivered.length).toBe(1)
        expect(delivered[0].type).toBe("delivery")
        expect(delivered[0].body.get("id")).toBe("m1")
    })

    it("deliverLive pushes to an already-connected socket, no reconnect", async () => {
        // T3.
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        const delivered: DecodedFrame[] = []
        ws.addEventListener("message", (event) => {
            delivered.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverLive(
                "did:plc:alice",
                {
                    messageId: "m1",
                    byteLength: 5,
                    hint: { senderDID: "did:plc:bob", anchorKeyThumbprint: "th" },
                },
                new TextEncoder().encode("hello")
            )
        )
        await expect.poll(() => delivered.length).toBe(1)
        expect(delivered[0].type).toBe("delivery")
        expect(delivered[0].body.get("k")).toBe("did:plc:alice")
        expect(delivered[0].body.get("id")).toBe("m1")
        expect(
            new TextDecoder().decode(delivered[0].body.get("m") as Uint8Array)
        ).toBe("hello")
        expect(delivered[0].body.get("sd")).toBe("did:plc:bob")
    })

    it("fans out to every attached socket", async () => {
        // T6.
        const stub = freshStub()
        const { ws: ws1 } = await connectAndDrain(stub)
        const { ws: ws2 } = await connectAndDrain(stub)
        const received1: DecodedFrame[] = []
        const received2: DecodedFrame[] = []
        ws1.addEventListener("message", (event) => {
            received1.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })
        ws2.addEventListener("message", (event) => {
            received2.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })

        await inPMR(stub, (pmr) =>
            pmr.deliverLive(
                "did:plc:alice",
                { messageId: "m1", byteLength: 5 },
                new TextEncoder().encode("hello")
            )
        )
        await expect.poll(() => received1.length).toBe(1)
        await expect.poll(() => received2.length).toBe(1)
    })

    it("is a no-op with nothing attached, and does not throw", async () => {
        // T7.
        const stub = freshStub()
        await expect(
            inPMR(stub, (pmr) =>
                pmr.deliverLive(
                    "did:plc:alice",
                    { messageId: "m1", byteLength: 5 },
                    new TextEncoder().encode("hello")
                )
            )
        ).resolves.toBeUndefined()
    })

    it("a socket whose send() throws does not block delivery to the others", async () => {
        // T11. Pins the guarded `ws.send` in `broadcast()`. A plain
        // client-side `ws.close()` doesn't exercise this: this test
        // runtime drops a cleanly-closed socket from `ctx.getWebSockets()`
        // immediately, so `broadcast()` never even attempts to send to it
        // (confirmed by mutation-testing an earlier version of this test
        // that used `close()` — it passed with the guard removed). What the
        // guard actually protects against is a peer that dropped WITHOUT a
        // clean close, which the platform may not have noticed yet — so
        // this test forces the failure directly on the DO-side socket.
        const stub = freshStub()
        const { ws: ws1 } = await connectAndDrain(stub)
        const { ws: ws2 } = await connectAndDrain(stub)
        const received: DecodedFrame[] = []
        const record = (event: MessageEvent) => {
            received.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        }
        ws1.addEventListener("message", record)
        ws2.addEventListener("message", record)

        await inPMR(stub, (pmr) => {
            const [socket] = (
                pmr as unknown as { ctx: DurableObjectState }
            ).ctx.getWebSockets()
            vi.spyOn(socket, "send").mockImplementation(() => {
                throw new Error("simulated dropped peer")
            })
        })

        await expect(
            inPMR(stub, (pmr) =>
                pmr.deliverLive(
                    "did:plc:alice",
                    { messageId: "m1", byteLength: 5 },
                    new TextEncoder().encode("hello")
                )
            )
        ).resolves.toBeUndefined()
        // Exactly one of the two sockets received it — the other's send
        // threw and was swallowed rather than blocking the rest of the fan-out.
        await expect.poll(() => received.length).toBe(1)
    })

    it("invalidateGrant still succeeds even if a socket's send() throws", async () => {
        // T12. Regression guard for the adjacent fix: broadcastCapabilities
        // now routes through the same guarded broadcast().
        const stub = freshStub()
        const future = Math.floor(Date.now() / 1000) + 3600
        await inPMR(stub, (pmr) =>
            pmr.issueGrant("addr-live", new Uint8Array(32), future)
        )
        await connectAndDrain(stub)
        await inPMR(stub, (pmr) => {
            const [socket] = (
                pmr as unknown as { ctx: DurableObjectState }
            ).ctx.getWebSockets()
            vi.spyOn(socket, "send").mockImplementation(() => {
                throw new Error("simulated dropped peer")
            })
        })

        await expect(
            inPMR(stub, (pmr) => pmr.invalidateGrant("addr-live"))
        ).resolves.toBeUndefined()
    })

    it("deliverLive and drainBacklog produce byte-identical frames for the same entry", async () => {
        // T13.
        const stub = freshStub()
        const ref = {
            messageId: "m1",
            byteLength: 5,
            hint: { senderDID: "did:plc:bob", anchorKeyThumbprint: "th" },
        }
        const body = new TextEncoder().encode("hello")

        await inPMR(stub, (pmr) => pmr.append("did:plc:alice", ref, new Uint8Array([1]), 0))
        await testEnv.messages.put("m1", body)
        const { frames: drained } = await connectAndDrain(stub)
        const viaDrain = drained.find((f) => f.type === "delivery")!

        const { ws: second } = await connectAndDrain(stub)
        const viaLive: DecodedFrame[] = []
        second.addEventListener("message", (event) => {
            viaLive.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })
        await inPMR(stub, (pmr) => pmr.deliverLive("did:plc:alice", ref, body))
        await expect.poll(() => viaLive.length).toBe(1)

        expect([...viaLive[0].body.entries()]).toEqual([...viaDrain.body.entries()])
    })
})

describe("live push on pool provisioning", () => {
    it("pushes provisioned messages to an attached socket without a reconnect", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.appendToPool(
                "did:plc:recovering",
                { messageId: "m1", byteLength: 5 },
                new Uint8Array([1]),
                0
            )
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hello"))

        const { ws } = await connectAndDrain(stub)
        const delivered: DecodedFrame[] = []
        ws.addEventListener("message", (event) => {
            delivered.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })

        const moved = await inPMR(stub, (pmr) =>
            pmr.provisionFromPool("did:plc:recovering", 0)
        )
        expect(moved).toHaveLength(1)

        await expect.poll(() => delivered.length).toBe(1)
        expect(delivered[0].type).toBe("delivery")
        expect(delivered[0].body.get("k")).toBe("did:plc:recovering")
        expect(delivered[0].body.get("id")).toBe("m1")
    })

    it("is a no-op with nothing attached, and does not throw", async () => {
        const stub = freshStub()
        await inPMR(stub, (pmr) =>
            pmr.appendToPool(
                "did:plc:recovering",
                { messageId: "m1", byteLength: 5 },
                new Uint8Array([1]),
                0
            )
        )
        await testEnv.messages.put("m1", new TextEncoder().encode("hello"))

        await expect(
            inPMR(stub, (pmr) => pmr.provisionFromPool("did:plc:recovering", 0))
        ).resolves.toEqual([{ messageId: "m1", byteLength: 5 }])
    })

    it("provisioning an empty sender pushes nothing", async () => {
        const stub = freshStub()
        const { ws } = await connectAndDrain(stub)
        const delivered: DecodedFrame[] = []
        ws.addEventListener("message", (event) => {
            delivered.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
        })

        await inPMR(stub, (pmr) => pmr.provisionFromPool("did:plc:nobody", 0))
        await new Promise((r) => setTimeout(r, 10))
        expect(delivered).toHaveLength(0)
    })
})
