/**
 * The owner's Bsky blocks are mirrored into the relay block: a blocked sender's
 * queued and pooled mail is cleared and their puts go synthetic, a Bsky unblock
 * lifts only what the mirror set, and a device block always stands.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    decodeFrame,
    type Admission,
    type DecodedFrame,
    type MessageRef,
    type Nonce,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = 1_760_000_000
const B = "did:plc:bob"
const C = "did:plc:carol"

const ref = (id: string): MessageRef => ({ messageId: id, byteLength: 100 })

let nonceCounter = 0
function freshNonce(): Nonce {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}

let counter = 0
function freshStub(): DurableObjectStub<PMRObject> {
    counter += 1
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`bsky-mirror-${counter}`))
}

const raw = (pmr: PMRObject, key: string) =>
    (pmr as unknown as { ctx: DurableObjectState }).ctx.storage.get(key)
const put = (pmr: PMRObject, did: string, id: string, admission: Admission) =>
    pmr.receive(did, ref(id), freshNonce(), T0, admission)
const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["not-admitted"] }

describe("PMRObject Bsky block mirror", () => {
    it("block with source bsky sets the marker, clears queue and pool, and lists the sender in listBlocked and listBskyBlocked", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, B, "m1", YES)
            await put(pmr, B, "p1", NO)
            await pmr.block(B, T0, "bsky")
            expect(await pmr.listBlocked()).toEqual([B])
            expect(await pmr.listBskyBlocked()).toEqual([B])
            expect(await pmr.list(B, 10)).toEqual([])
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("syncBskyBlocks blocks a sender in the set the relay holds a mailbox or pool entry for", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const D = "did:plc:dave"
            await put(pmr, B, "m1", YES)
            await put(pmr, C, "p1", NO)
            // A device contact: a mailbox with no admitted mark.
            await pmr.append(D, ref("d1"), freshNonce(), T0)
            await pmr.syncBskyBlocks(new Set([B, C, D]))
            expect((await pmr.listBskyBlocked()).sort()).toEqual([B, C, D])
            expect(await pmr.list(B, 10)).toEqual([])
            expect(await pmr.list(D, 10)).toEqual([])
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("syncBskyBlocks does not create a marker for a sender the relay holds nothing for", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.syncBskyBlocks(new Set([B, "grant:abc"]))
            expect(await pmr.listBlocked()).toEqual([])
        })
    })

    it("syncBskyBlocks does not mistake a grant mailbox for a sender", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.append("grant:abc", ref("g1"), freshNonce(), T0)
            await pmr.syncBskyBlocks(new Set(["grant:abc"]))
            expect(await pmr.listBlocked()).toEqual([])
            expect(await pmr.list("grant:abc", 10)).toHaveLength(1)
        })
    })

    it("syncBskyBlocks lifts a bsky marker whose sender left the set", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, B, "m1", YES)
            await pmr.syncBskyBlocks(new Set([B]))
            await pmr.syncBskyBlocks(new Set())
            expect(await pmr.listBlocked()).toEqual([])
            expect(await raw(pmr, `bsky:${B}`)).toBeUndefined()
        })
    })

    it("syncBskyBlocks never lifts a device marker", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            // A held key for a device-blocked sender, as a stray write would leave.
            await (pmr as unknown as { ctx: DurableObjectState }).ctx.storage.put(`mbox:${B}`, [])
            await pmr.syncBskyBlocks(new Set())
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("a device block of a bsky-mirrored sender takes ownership, so leaving the set does not lift it", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, B, "m1", YES)
            await pmr.syncBskyBlocks(new Set([B]))
            await pmr.block(B, T0)
            expect(await pmr.listBskyBlocked()).toEqual([])
            await pmr.syncBskyBlocks(new Set())
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("a bsky block of a device-blocked sender leaves the device marker as it is", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            await pmr.block(B, T0, "bsky")
            expect(await pmr.listBskyBlocked()).toEqual([])
            await pmr.syncBskyBlocks(new Set([B]))
            expect(await pmr.listBskyBlocked()).toEqual([])
            await pmr.syncBskyBlocks(new Set())
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("a device unblock while the bsky block stands is re-blocked by the sender's next put", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, B, "m1", YES)
            await pmr.syncBskyBlocks(new Set([B]))
            await pmr.unblock(B)
            expect(await pmr.listBlocked()).toEqual([])
            const result = await put(pmr, B, "m2", { verdict: "blocked" })
            expect(result).toEqual({ outcome: "queued", persistBody: false })
            expect(await pmr.listBskyBlocked()).toEqual([B])
            expect(await pmr.list(B, 10)).toEqual([])
        })
    })

    it("clearing leaves message bodies to their TTL", async () => {
        const stub = freshStub()
        await testEnv.messages.put("m1", "body")
        await testEnv.messages.put("p1", "body")
        await inPMR(stub, async (pmr) => {
            await put(pmr, B, "m1", YES)
            await put(pmr, C, "p1", NO)
            await pmr.syncBskyBlocks(new Set([B, C]))
        })
        expect(await testEnv.messages.get("m1")).toBe("body")
        expect(await testEnv.messages.get("p1")).toBe("body")
    })
})

describe("PMRObject catch-up wiring", () => {
    let owners = 0
    const ingest = () => {
        const ns = testEnv.MONITOR_INGEST!
        return ns.get(ns.idFromName(testEnv.MONITOR_INGEST_NAME!)) as unknown as DurableObjectStub<MonitorIngestStub>
    }

    /** A registered owner whose relay holds an admitted mailbox for B. */
    async function ownerWithQueue() {
        owners += 1
        const owner = `did:plc:mirror-owner-${owners}`
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.update({ did: owner })
            await put(pmr, B, `m-${owners}`, YES)
        })
        await testEnv.messages.put(`m-${owners}`, new Uint8Array([1]))
        return { owner, stub, messageId: `m-${owners}` }
    }

    async function drain(stub: DurableObjectStub<PMRObject>) {
        const response = await stub.fetch("https://relay.example/pmr/v1/events", {
            headers: { Upgrade: "websocket" },
        })
        const ws = response.webSocket!
        ws.binaryType = "arraybuffer"
        ws.accept()
        const frames: DecodedFrame[] = []
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("message", (event) => {
                const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
                frames.push(frame)
                if (frame.type === "caughtUp") resolve()
            })
            ws.addEventListener("error", reject)
        })
        ws.close()
        return frames
    }

    it("the events socket drain mirrors the owner's blocks from MONITOR_INGEST before delivering", async () => {
        const { owner, stub } = await ownerWithQueue()
        await ingest().setOwnBlocks(owner, [{ blocker: owner, rkey: "3k1", subject: B }])
        const frames = await drain(stub)
        expect(frames.filter((f) => f.type === "delivery")).toEqual([])
        await inPMR(stub, async (pmr) => {
            expect(await pmr.listBskyBlocked()).toEqual([B])
        })
    })

    it("a missing or failing monitor still drains, on last-known blocks", async () => {
        const { owner, stub } = await ownerWithQueue()
        await ingest().setOwnBlocks(owner, "throw")
        const frames = await drain(stub)
        expect(frames.filter((f) => f.type === "delivery")).toHaveLength(1)
        await inPMR(stub, async (pmr) => {
            expect(await pmr.listBskyBlocked()).toEqual([])
        })
    })
})
