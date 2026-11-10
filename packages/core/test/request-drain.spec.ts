/**
 * Request mailboxes never wake the device: the connect-time backlog is
 * capabilities, queued messages, then caught-up, with nothing about them.
 */
import { describe, expect, it } from "vitest"
import { decodeFrame, drainBacklog, type EventsDeps } from "../src/events"
import type { BodyStore, MessageRef, PMRStore } from "../src/storage"

const ref = (id: string): MessageRef => ({ messageId: id, byteLength: 1 })

function world() {
    const touched: string[] = []
    const backing = {
        async openMailboxes() {
            return {
                entries: [
                    { key: "did:plc:alice", messages: [ref("m1")] },
                    { key: "grant:addr", messages: [ref("m2")] },
                ],
                nextCursor: null,
            }
        },
    } as Record<string, unknown>
    // Any other store method is a read the drain must not make.
    const store = new Proxy(backing, {
        get(target, prop) {
            touched.push(String(prop))
            return target[prop as string]
        },
    }) as unknown as PMRStore
    const bodies = new Map([
        ["m1", new Uint8Array([1])],
        ["m2", new Uint8Array([2])],
    ])
    const bodyStore: BodyStore = {
        async putBody() {},
        async getBody(id) {
            return bodies.get(id) ?? null
        },
        async deleteBody() {},
    }
    const deps: EventsDeps = { store, bodies: bodyStore }
    return { deps, touched }
}

describe("drainBacklog", () => {
    it("sends #capabilities, every queued delivery, then #caughtUp and no other frame", async () => {
        const { deps } = world()
        const frames: Uint8Array[] = []
        await drainBacklog(deps, { grant: "active" }, (frame) => frames.push(frame))
        expect(frames.map((frame) => decodeFrame(frame).type)).toEqual([
            "capabilities",
            "delivery",
            "delivery",
            "caughtUp",
        ])
    })

    it("does not read request mailboxes", async () => {
        const { deps, touched } = world()
        await drainBacklog(deps, { grant: "active" }, () => {})
        expect(touched).toEqual(["openMailboxes"])
    })
})
