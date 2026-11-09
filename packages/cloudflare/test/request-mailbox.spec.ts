/**
 * A request mailbox holds puts from a sender admission did not admit. It
 * refuses when the sender's own depth is full, keeps nothing more once the
 * recipient's shared byte quota is full, and exists only while it holds an
 * entry.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MessageRef, Nonce, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv

const T0 = Math.floor(Date.now() / 1000)
const DEPTH = parseInt(testEnv.REQUEST_DEPTH_PER_SENDER)
const CAP = parseInt(testEnv.REQUEST_SHARED_CAP_BYTES)

const did = (name: string) => `did:plc:${name}` as PairMailboxKey

function ref(id: string, byteLength = 100): MessageRef {
    return { messageId: id, byteLength }
}

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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`req-mailbox-${counter}`))
}

const storageOf = (pmr: PMRObject) => (pmr as unknown as { db: DurableObjectStorage }).db

/** Every storage operation the object issues while `fn` runs, as `op:keyFamily`. */
async function traceStorage(pmr: PMRObject, fn: () => Promise<unknown>): Promise<string[]> {
    const target = storageOf(pmr)
    const ops: string[] = []
    const traced = new Proxy(target, {
        get(t, prop) {
            const value = (t as unknown as Record<string | symbol, unknown>)[prop]
            if (typeof value !== "function") return value
            return (...args: unknown[]) => {
                const first = args[0]
                const family = typeof first === "string" ? first.split(":")[0] : "-"
                ops.push(`${String(prop)}:${family}`)
                return (value as (...a: unknown[]) => unknown).apply(t, args)
            }
        },
    })
    ;(pmr as unknown as { db: DurableObjectStorage }).db = traced
    try {
        await fn()
    } finally {
        ;(pmr as unknown as { db: DurableObjectStorage }).db = target
    }
    return ops
}

describe("PMRObject.appendToRequest", () => {
    it("holds a put in the sender's request mailbox and records its nonce", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            expect(await pmr.appendToRequest(did("a"), ref("m1"), nonce, T0)).toEqual({ outcome: "held" })
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toEqual([ref("m1")])
            expect(await pmr.appendToRequest(did("a"), ref("m1"), nonce, T0)).toEqual({ outcome: "duplicate" })
        })
    })

    it("answers a repeated nonce duplicate and writes nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            await pmr.appendToRequest(did("a"), ref("m1", 40), nonce, T0)
            const ops = await traceStorage(pmr, async () => {
                expect(await pmr.appendToRequest(did("a"), ref("m2", 40), nonce, T0)).toEqual({
                    outcome: "duplicate",
                })
            })
            expect(ops.filter((op) => op.startsWith("put") || op.startsWith("delete"))).toEqual([])
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toEqual([ref("m1", 40)])
            expect(await storageOf(pmr).get("reqBytes")).toBe(40)
        })
    })

    it("refuses past the sender's depth with the shared retry instant, keeping the oldest entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < DEPTH; i++) {
                await pmr.appendToRequest(did("a"), ref(`m${i}`), freshNonce(), T0)
            }
            const first = await pmr.appendToRequest(did("a"), ref("late"), freshNonce(), T0)
            expect(first).toEqual({ outcome: "refused", retryAfter: expect.any(Number) })
            const retryAfter = first.outcome === "refused" ? first.retryAfter : 0
            expect(retryAfter).toBeGreaterThan(T0)
            expect(await storageOf(pmr).get(`retry:${did("a")}`)).toBe(retryAfter)
            // Stable until it passes: the same source a full pair mailbox draws from.
            expect(await pmr.appendToRequest(did("a"), ref("later"), freshNonce(), T0 + 1)).toEqual(first)
            const kept = (await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`))!
            expect(kept.map((r) => r.messageId)).toEqual(Array.from({ length: DEPTH }, (_, i) => `m${i}`))
        })
    })

    it("records no nonce on a refusal, so a retry is judged afresh once there is room", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < DEPTH; i++) {
                await pmr.appendToRequest(did("a"), ref(`m${i}`), freshNonce(), T0)
            }
            const nonce = freshNonce()
            expect((await pmr.appendToRequest(did("a"), ref("late"), nonce, T0)).outcome).toBe("refused")
            const queue = (await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`))!
            await storageOf(pmr).put(`req:${did("a")}`, queue.slice(1))
            expect(await pmr.appendToRequest(did("a"), ref("late"), nonce, T0)).toEqual({ outcome: "held" })
        })
    })

    it("drops a put whose bytes do not fit the shared quota, keeping nothing and recording no nonce", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToRequest(did("filler"), ref("fill", CAP - 50), freshNonce(), T0)
            const nonce = freshNonce()
            expect(await pmr.appendToRequest(did("b"), ref("m1", 51), nonce, T0)).toEqual({ outcome: "dropped" })
            expect(await storageOf(pmr).get(`req:${did("b")}`)).toBeUndefined()
            expect(await storageOf(pmr).get("reqBytes")).toBe(CAP - 50)
            // Exactly fitting is held, and the dropped nonce was never consumed.
            expect(await pmr.appendToRequest(did("b"), ref("m1", 50), nonce, T0)).toEqual({ outcome: "held" })
        })
    })

    it("checks the sender's depth before the shared quota", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < DEPTH; i++) {
                await pmr.appendToRequest(did("a"), ref(`m${i}`, 1), freshNonce(), T0)
            }
            await pmr.appendToRequest(did("filler"), ref("fill", CAP - DEPTH), freshNonce(), T0)
            expect(await storageOf(pmr).get("reqBytes")).toBe(CAP)
            expect((await pmr.appendToRequest(did("a"), ref("late", 1), freshNonce(), T0)).outcome).toBe("refused")
        })
    })

    it("charges each held entry's bytes to the shared quota", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToRequest(did("a"), ref("m1", 10), freshNonce(), T0)
            await pmr.appendToRequest(did("a"), ref("m2", 20), freshNonce(), T0)
            await pmr.appendToRequest(did("b"), ref("m3", 30), freshNonce(), T0)
            expect(await storageOf(pmr).get("reqBytes")).toBe(60)
        })
    })

    it("takes the same storage round trips for a dropped put as for a held one", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const heldOps = await traceStorage(pmr, () =>
                pmr.appendToRequest(did("a"), ref("m1", 100), freshNonce(), T0)
            )
            await pmr.appendToRequest(did("filler"), ref("fill", CAP - 100 - 100 + 1), freshNonce(), T0)
            let outcome = ""
            const droppedOps = await traceStorage(pmr, async () => {
                outcome = (await pmr.appendToRequest(did("b"), ref("m1", 100), freshNonce(), T0)).outcome
            })
            expect(outcome).toBe("dropped")
            // Only the reads are compared: a dropped put skips the writes by design.
            const reads = (ops: string[]) => ops.filter((op) => op.startsWith("get"))
            expect(reads(droppedOps)).toEqual(reads(heldOps))
            expect(reads(heldOps).length).toBeGreaterThan(0)
        })
    })
})

describe("request entries under the sender's key", () => {
    it.todo("getMessage finds a request entry by sender DID and id")
    it.todo("getMessage misses identically for an acked request entry, an unknown id and an absent sender")
    it.todo("getMessage and remove reach both tiers when one sender holds pair and request entries")
    it.todo("never holds one message id in both tiers")
    it.todo("remove applies the same pair-generation rule to a request entry as to a pair entry")
    it.todo("remove deletes a request entry idempotently and refunds its bytes")
    it.todo("removing the last request entry leaves no request mailbox key")
    it.todo("request entries never appear in openMailboxes or list, and do not make hasMailbox true")
    it.todo("a request-only sender with a proof row yields no openMailboxes descriptor")
})

describe("PMRObject.requestMailboxes", () => {
    it.todo("lists each request mailbox's DID with its entry ids oldest first, in key order")
    it.todo("pages by limit and resumes from nextCursor, ending with null")
    it.todo("lists nothing for a recipient with no request entries")
})
