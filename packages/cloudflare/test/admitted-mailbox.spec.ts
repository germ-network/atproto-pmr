/**
 * The store routes each judged pair put in one step. Admission is
 * judged again on every put: a yes goes to the pair mailbox, anything else to
 * the request mailbox (see request-routing.spec.ts). This file covers the
 * outcomes around that routing: replays, blocks, refusals and drain.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef, Nonce } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = 1_760_000_000
const B = "did:plc:bob"
const CAPACITY = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)

const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["not-admitted"] }
const UNKNOWN: Admission = { verdict: "unknown", why: ["admission-unavailable"] }
const BLOCKED: Admission = { verdict: "blocked" }

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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`admitted-${counter}`))
}

const raw = (pmr: PMRObject, key: string) =>
    (pmr as unknown as { ctx: DurableObjectState }).ctx.storage.get(key)

const put = (pmr: PMRObject, id: string, admission: Admission, now = T0, nonce = freshNonce()) =>
    pmr.receive(B, ref(id), nonce, now, admission)

const ids = async (pmr: PMRObject) => (await pmr.list(B, 100)).map((r) => r.messageId)

describe("PMRObject.receive", () => {
    it("yes with nothing held opens a mailbox and queues the ref", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await put(pmr, "m1", YES)).toEqual({ outcome: "queued", persistBody: true })
            expect(await ids(pmr)).toEqual(["m1"])
        })
    })

    it("a replayed nonce is a duplicate on the pair and synthetic paths", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            await put(pmr, "m1", YES, T0, nonce)
            expect(await put(pmr, "m1", YES, T0, nonce)).toEqual({ outcome: "duplicate" })
        })
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            const nonce = freshNonce()
            await put(pmr, "m1", YES, T0, nonce)
            expect(await put(pmr, "m1", YES, T0, nonce)).toEqual({ outcome: "duplicate" })
        })
    })

    it("a bsky block of an admitted sender clears its queue and goes synthetic", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            expect(await put(pmr, "m2", BLOCKED)).toEqual({ outcome: "queued", persistBody: false })
            expect(await ids(pmr)).toEqual([])
            expect(await raw(pmr, `bsky:${B}`)).toBeDefined()
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("a refusal records no nonce, so a retry once there is room is evaluated fresh", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY; i++) await put(pmr, `q${i}`, YES)
            const nonce = freshNonce()
            expect((await put(pmr, "over", YES, T0, nonce)).outcome).toBe("refused")
            await pmr.remove(B, "q0")
            expect((await put(pmr, "over", YES, T0, nonce)).outcome).toBe("queued")
        })
    })

    it("a device-blocked sender is absorbed synthetically whatever the verdict, as append's blocked path", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            for (const [i, admission] of [YES, NO, UNKNOWN, BLOCKED].entries()) {
                expect(await put(pmr, `m${i}`, admission)).toEqual({ outcome: "queued", persistBody: false })
            }
            expect(await ids(pmr)).toEqual([])
            expect((await pmr.requestMailboxes(null, 10)).entries).toEqual([])
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("blocked mirrors a bsky block, clearing the queue, and absorbs the put synthetically", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            expect(await put(pmr, "m2", BLOCKED)).toEqual({ outcome: "queued", persistBody: false })
            expect(await ids(pmr)).toEqual([])
            expect(await raw(pmr, `bsky:${B}`)).toBeDefined()
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("yes does not lift a bsky marker: the sender stays blocked and the put is absorbed synthetically", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", BLOCKED)
            expect(await put(pmr, "m2", YES)).toEqual({ outcome: "queued", persistBody: false })
            expect(await pmr.listBlocked()).toEqual([B])
            expect(await raw(pmr, `bsky:${B}`)).toBeDefined()
            expect(await ids(pmr)).toEqual([])
        })
    })

    it("after a device unblock of a bsky-mirrored sender, a yes routes the put to an admitted mailbox", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", BLOCKED)
            await pmr.unblock(B)
            expect(await put(pmr, "m2", YES)).toEqual({ outcome: "queued", persistBody: true })
            expect(await pmr.listBlocked()).toEqual([])
            expect(await ids(pmr)).toEqual(["m2"])
        })
    })

    it("no or unknown (including admission-unavailable) leave a bsky marker in place and the put is absorbed synthetically", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", BLOCKED)
            for (const [i, admission] of [NO, UNKNOWN].entries()) {
                expect(await put(pmr, `n${i}`, admission)).toEqual({ outcome: "queued", persistBody: false })
            }
            expect(await pmr.listBlocked()).toEqual([B])
            expect(await raw(pmr, `bsky:${B}`)).toBeDefined()
            expect((await pmr.requestMailboxes(null, 10)).entries).toEqual([])
        })
    })

    it("blocked for a device-blocked sender writes no bsky marker", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            await put(pmr, "m1", BLOCKED)
            expect(await raw(pmr, `bsky:${B}`)).toBeUndefined()
        })
    })

    it("a duplicate nonce writes nothing, including no block-marker transition", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            await put(pmr, "m1", YES, T0, nonce)
            expect(await put(pmr, "m1", BLOCKED, T0, nonce)).toEqual({ outcome: "duplicate" })
            expect(await pmr.listBlocked()).toEqual([])
            expect(await ids(pmr)).toEqual(["m1"])
        })
    })

    it("a yes is refused only when the new ref does not fit, and that refusal writes no mailbox or move", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY; i++) await put(pmr, `q${i}`, YES)
            await put(pmr, "p1", NO)
            const result = await put(pmr, "over", YES)
            expect(result.outcome).toBe("refused")
            expect(await ids(pmr)).toHaveLength(CAPACITY)
            expect(await ids(pmr)).not.toContain("p1")
            expect((await pmr.requestMailboxes(null, 10)).entries).toEqual([{ key: B, messageIds: ["p1"] }])
        })
        await inPMR(freshStub(), async (pmr) => {
            // One slot short of full: the new ref still fits.
            for (let i = 0; i < CAPACITY - 1; i++) await put(pmr, `q${i}`, YES)
            expect((await put(pmr, "last", YES)).outcome).toBe("queued")
            expect(await ids(pmr)).toHaveLength(CAPACITY)
        })
    })

    it("an admitted mailbox at capacity is refused with the synthetic path's Retry-After source", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY; i++) await put(pmr, `q${i}`, YES)
            const SENTINEL = T0 + 999_111
            ;(pmr as unknown as { synthetic: unknown }).synthetic = {
                nextRetryInstant: () => SENTINEL,
                advance: () => ({ state: {}, accepted: true }),
            }
            expect(await put(pmr, "over", YES)).toEqual({ outcome: "refused", retryAfter: SENTINEL })
        })
    })

    it("an admitted mailbox's messages drain and ack like any pair mailbox's", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            await put(pmr, "m2", YES)
            const page = await pmr.openMailboxes(null, 10)
            expect(page.entries).toEqual([{ key: B, messages: [ref("m1"), ref("m2")] }])
            await pmr.remove(B, "m1")
            expect(await ids(pmr)).toEqual(["m2"])
        })
    })
})
