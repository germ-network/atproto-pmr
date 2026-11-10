/**
 * The `#summary` graph-change hint: sent only to attached sockets, never
 * thrown, coalesced, and never part of the connect-time backlog.
 */
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { decodeFrame, type DecodedFrame } from "@germ-network/atproto-pmr-core"
import { PMRObject } from "../src/pmr-object"
import type { PMREnv } from "../src/env"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`summary-nudge-${counter}`))
}

async function connectAndDrain(
    stub: DurableObjectStub<PMRObject>
): Promise<{ ws: WebSocket; frames: DecodedFrame[] }> {
    const response = await stub.fetch("https://relay.example/pmr/v1/events", {
        headers: { Upgrade: "websocket" },
    })
    expect(response.status).toBe(101)
    const ws = response.webSocket
    if (ws === null) throw new Error("expected a WebSocket in the 101 response")
    ws.binaryType = "arraybuffer"
    ws.accept()
    const frames: DecodedFrame[] = []
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", (event) => {
            const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
            frames.push(frame)
            if (frame.type === "caughtUp") resolve()
        })
        ws.addEventListener("error", (e) => reject(e))
    })
    return { ws, frames }
}

/** Frames received on `ws` from now on. */
function collect(ws: WebSocket): DecodedFrame[] {
    const received: DecodedFrame[] = []
    ws.addEventListener("message", (event) => {
        received.push(decodeFrame(new Uint8Array(event.data as ArrayBuffer)))
    })
    return received
}

const setInterval_ = (stub: DurableObjectStub<PMRObject>, ms: number) =>
    inPMR(stub, (pmr) => {
        ;(pmr as unknown as { summaryNudgeIntervalMs: number }).summaryNudgeIntervalMs = ms
    })

const nudge = (stub: DurableObjectStub<PMRObject>) =>
    inPMR(stub, (pmr) => pmr.nudgeSummary())

describe("nudgeSummary", () => {
    it("sends nothing and resolves with no socket attached", async () => {
        const stub = freshStub()
        await setInterval_(stub, 60_000)
        await expect(nudge(stub)).resolves.toBeUndefined()
        // Nothing was stamped or scheduled, so the first nudge with a
        // socket attached is still a leading one.
        const { ws } = await connectAndDrain(stub)
        const received = collect(ws)
        await nudge(stub)
        await expect.poll(() => received.map((f) => f.type)).toEqual(["summary"])
    })

    it("sends one #summary frame to each attached socket", async () => {
        const stub = freshStub()
        const { ws: ws1 } = await connectAndDrain(stub)
        const { ws: ws2 } = await connectAndDrain(stub)
        const received1 = collect(ws1)
        const received2 = collect(ws2)

        await nudge(stub)

        const expected: DecodedFrame[] = [{ type: "summary", body: new Map() }]
        await expect.poll(() => received1).toEqual(expected)
        await expect.poll(() => received2).toEqual(expected)
    })

    it("a socket whose send() throws neither escapes nor stops the others receiving it", async () => {
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

        await expect(nudge(stub)).resolves.toBeUndefined()
        await expect.poll(() => received.length).toBe(1)
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(received.length).toBe(1)
    })

    it("nudges inside the interval coalesce into one trailing frame", async () => {
        const stub = freshStub()
        const intervalMs = 300
        await setInterval_(stub, intervalMs)
        const { ws } = await connectAndDrain(stub)
        const received = collect(ws)
        const burst = () =>
            inPMR(stub, async (pmr) => {
                for (let i = 0; i < 5; i++) await pmr.nudgeSummary()
            })

        await burst()
        await expect.poll(() => received.length).toBe(2)

        // The trailing send opened a new interval: a burst right after it
        // is throttled and trailed again, not sent at once.
        await burst()
        await new Promise((resolve) => setTimeout(resolve, intervalMs / 3))
        expect(received.length).toBe(2)

        await new Promise((resolve) => setTimeout(resolve, intervalMs * 3))
        expect(received.map((f) => f.type)).toEqual(["summary", "summary", "summary"])
    })

    it("a socket that connects after a nudge sees no #summary in its backlog", async () => {
        const stub = freshStub()
        await connectAndDrain(stub)
        await nudge(stub)

        const { frames } = await connectAndDrain(stub)
        expect(frames.map((f) => f.type)).toEqual(["capabilities", "caughtUp"])
    })
})
