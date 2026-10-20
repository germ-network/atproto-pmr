/**
 * The store routes each adjudicated pair put in one step. A server-admitted
 * mailbox delivers like a provisioned one but is judged again on every put
 * until the device provisions the sender, which makes it a device contact.
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
    it("yes with nothing held opens a mailbox marked admitted and queues the ref", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await put(pmr, "m1", YES)).toEqual({ outcome: "queued", persistBody: true })
            expect(await ids(pmr)).toEqual(["m1"])
            expect(await raw(pmr, `adm:${B}`)).toBeDefined()
        })
    })

    it("yes moves the sender's pooled entries into the admitted queue ahead of the new ref, returns them as moved, and drops their verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "p1", NO)
            await put(pmr, "p2", NO)
            const result = await put(pmr, "m1", YES)
            expect(result).toEqual({
                outcome: "queued",
                persistBody: true,
                moved: [ref("p1"), ref("p2")],
            })
            expect(await ids(pmr)).toEqual(["p1", "p2", "m1"])
            expect(await pmr.poolSenders()).toEqual([])
            expect(await raw(pmr, `poolv:${B}`)).toBeUndefined()
            expect(await raw(pmr, "poolBytes")).toBe(0)
        })
    })

    it("yes inside a live discard window still queues", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.setDiscarded(B, T0 + 100)
            expect((await put(pmr, "m1", YES)).outcome).toBe("queued")
            expect(await ids(pmr)).toEqual(["m1"])
        })
    })

    it("no or unknown with nothing held pools the ref with its verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await put(pmr, "m1", NO)).toEqual({ outcome: "pooled", persistBody: true })
            expect(await pmr.poolSenders()).toEqual([
                { did: B, count: 1, verdict: { verdict: "no", why: ["not-admitted"] } },
            ])
            await put(pmr, "m2", UNKNOWN)
            expect(await pmr.poolSenders()).toEqual([
                { did: B, count: 2, verdict: { verdict: "unknown", why: ["admission-unavailable"] } },
            ])
            expect(await ids(pmr)).toEqual([])
            expect(await raw(pmr, `mbox:${B}`)).toBeUndefined()
        })
    })

    it("no or unknown inside a live discard window is dropped as pooled, persistBody false", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.setDiscarded(B, T0 + 100)
            for (const admission of [NO, UNKNOWN]) {
                expect(await put(pmr, "m1", admission)).toEqual({ outcome: "pooled", persistBody: false })
            }
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("no or unknown from an admitted sender pools the ref and leaves its queue as it is", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            expect((await put(pmr, "m2", NO)).outcome).toBe("pooled")
            expect(await ids(pmr)).toEqual(["m1"])
            expect((await pmr.poolSenders())[0]).toMatchObject({ did: B, count: 1 })
            expect(await raw(pmr, `adm:${B}`)).toBeDefined()
        })
    })

    it("a device-provisioned sender is queued whatever the verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.provisionFromPool(B, T0)
            for (const [i, admission] of [NO, UNKNOWN, YES].entries()) {
                expect(await put(pmr, `m${i}`, admission)).toEqual({ outcome: "queued", persistBody: true })
            }
            expect(await ids(pmr)).toEqual(["m0", "m1", "m2"])
            expect(await raw(pmr, `adm:${B}`)).toBeUndefined()
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("a replayed nonce is a duplicate on the provisioned and synthetic paths", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.provisionFromPool(B, T0)
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

    it("a bsky block of a device-provisioned sender clears its queue and goes synthetic", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.provisionFromPool(B, T0)
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
            expect(await pmr.poolSenders()).toEqual([])
            expect(await pmr.listBlocked()).toEqual([B])
        })
    })

    it("blocked mirrors a bsky block, clearing queue, pool and admitted mark, and absorbs the put synthetically", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            await put(pmr, "p1", NO)
            expect(await put(pmr, "m2", BLOCKED)).toEqual({ outcome: "queued", persistBody: false })
            expect(await ids(pmr)).toEqual([])
            expect(await pmr.poolSenders()).toEqual([])
            expect(await raw(pmr, `adm:${B}`)).toBeUndefined()
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
            expect(await raw(pmr, `adm:${B}`)).toBeUndefined()
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
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("blocked for a device-blocked sender writes no bsky marker", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(B, T0)
            await put(pmr, "m1", BLOCKED)
            expect(await raw(pmr, `bsky:${B}`)).toBeUndefined()
        })
    })

    it("a duplicate nonce or a paused registration writes nothing, including no block-marker transition", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            await put(pmr, "m1", YES, T0, nonce)
            expect(await put(pmr, "m1", BLOCKED, T0, nonce)).toEqual({ outcome: "duplicate" })
            expect(await pmr.listBlocked()).toEqual([])
            expect(await ids(pmr)).toEqual(["m1"])
        })
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: 5 })
            for (const admission of [BLOCKED, YES, NO]) {
                expect(await put(pmr, "m1", admission)).toEqual({ outcome: "queued", persistBody: false })
            }
            expect(await pmr.listBlocked()).toEqual([])
            expect(await raw(pmr, `mbox:${B}`)).toBeUndefined()
            expect(await pmr.poolSenders()).toEqual([])
        })
    })

    it("a yes is refused only when the new ref does not fit, and that refusal writes no mailbox, mark or move", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY; i++) await put(pmr, `q${i}`, YES)
            await put(pmr, "p1", NO)
            const result = await put(pmr, "over", YES)
            expect(result.outcome).toBe("refused")
            expect(await ids(pmr)).toHaveLength(CAPACITY)
            expect(await ids(pmr)).not.toContain("p1")
            expect((await pmr.poolSenders())[0]).toMatchObject({ did: B, count: 1 })
        })
        await inPMR(freshStub(), async (pmr) => {
            // One slot short of full: the new ref still fits.
            for (let i = 0; i < CAPACITY - 1; i++) await put(pmr, `q${i}`, YES)
            expect((await put(pmr, "last", YES)).outcome).toBe("queued")
            expect(await ids(pmr)).toHaveLength(CAPACITY)
        })
    })

    it("a yes with more pooled entries than room moves the oldest that fit and leaves the rest pooled with their verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY - 3; i++) await put(pmr, `q${i}`, YES)
            await put(pmr, "p1", NO)
            await put(pmr, "p2", NO)
            await put(pmr, "p3", NO)
            const result = await put(pmr, "new", YES)
            expect(result).toMatchObject({ outcome: "queued", moved: [ref("p1"), ref("p2")] })
            const queue = await ids(pmr)
            expect(queue.slice(-3)).toEqual(["p1", "p2", "new"])
            expect(queue).toHaveLength(CAPACITY)
            expect(await pmr.poolSenders()).toEqual([
                { did: B, count: 1, verdict: { verdict: "no", why: ["not-admitted"] } },
            ])
            // Moved bytes returned to the pool budget; the leftover's stay.
            expect(await raw(pmr, "poolBytes")).toBe(100)
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

    it("provisionFromPool clears the admitted mark, with or without pooled entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            await put(pmr, "p1", NO)
            await pmr.provisionFromPool(B, T0)
            expect(await raw(pmr, `adm:${B}`)).toBeUndefined()
            // From here the sender is a device contact: policy is ignored.
            expect((await put(pmr, "m2", NO)).outcome).toBe("queued")
            expect(await ids(pmr)).toEqual(["m1", "p1", "m2"])
        })
        await inPMR(freshStub(), async (pmr) => {
            await put(pmr, "m1", YES)
            await pmr.provisionFromPool(B, T0)
            expect(await raw(pmr, `adm:${B}`)).toBeUndefined()
        })
    })

    it("an admitted mailbox's messages drain and ack like a provisioned mailbox's", async () => {
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
