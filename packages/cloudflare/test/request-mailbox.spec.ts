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

/** A sender's stored request entries without the bookkeeping the object keeps beside them. */
async function storedRequest(pmr: PMRObject, who: PairMailboxKey): Promise<MessageRef[] | undefined> {
    const refs = await storageOf(pmr).get<Array<MessageRef & { heldAt?: number }>>(`req:${who}`)
    return refs?.map(({ heldAt: _heldAt, ...bare }) => bare)
}

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
            expect(await storedRequest(pmr, did("a"))).toEqual([ref("m1")])
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
            expect(await storedRequest(pmr, did("a"))).toEqual([ref("m1", 40)])
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
            const reads = (ops: string[]) => ops.filter((op) => op.startsWith("get:"))
            expect(reads(droppedOps)).toEqual(reads(heldOps))
            expect(reads(heldOps).length).toBeGreaterThan(0)
        })
    })
})

describe("request entries under the sender's key", () => {
    const held = (pmr: PMRObject, who: string, id: string, bytes = 100, extra: Partial<MessageRef> = {}) =>
        pmr.appendToRequest(did(who), { ...ref(id, bytes), ...extra }, freshNonce(), T0)

    it("getMessage finds a request entry by sender DID and id", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1")
            await held(pmr, "a", "m2", 7)
            expect(await pmr.getMessage(did("a"), "m2")).toEqual(ref("m2", 7))
        })
    })

    it("getMessage misses identically for an acked request entry, an unknown id and an absent sender", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1")
            await held(pmr, "a", "m2")
            await pmr.remove(did("a"), "m1")
            expect(await pmr.getMessage(did("a"), "m1")).toBeNull()
            expect(await pmr.getMessage(did("a"), "unknown")).toBeNull()
            expect(await pmr.getMessage(did("nobody"), "m2")).toBeNull()
            // Storage rejects a key over 2 KiB in production, so an over-long key must never reach it.
            const ops = await traceStorage(pmr, async () => {
                expect(await pmr.getMessage(`did:web:${"x".repeat(3000)}` as PairMailboxKey, "m2")).toBeNull()
            })
            expect(ops).toEqual([])
        })
    })

    it("getMessage and remove reach both tiers when one sender holds pair and request entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.append(did("a"), ref("deep"), freshNonce(), T0)
            await held(pmr, "a", "shallow")
            expect(await pmr.getMessage(did("a"), "deep")).toEqual(ref("deep"))
            expect(await pmr.getMessage(did("a"), "shallow")).toEqual(ref("shallow"))

            await pmr.remove(did("a"), "shallow")
            expect(await pmr.getMessage(did("a"), "shallow")).toBeNull()
            expect(await pmr.getMessage(did("a"), "deep")).toEqual(ref("deep"))
            await pmr.remove(did("a"), "deep")
            expect(await pmr.getMessage(did("a"), "deep")).toBeNull()
        })
    })

    it("never holds one message id in both tiers", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.append(did("a"), ref("same"), freshNonce(), T0)
            expect(await pmr.appendToRequest(did("a"), ref("same"), freshNonce(), T0)).toEqual({
                outcome: "duplicate",
            })
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await storageOf(pmr).get("reqBytes")).toBeUndefined()
        })
    })

    it("remove applies the same pair-generation rule to a request entry as to a pair entry", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1", 100, { pairGeneration: "g1" })
            await held(pmr, "a", "m2", 100, { pairGeneration: "g1" })
            await pmr.remove(did("a"), "m1", "g2")
            expect(await pmr.getMessage(did("a"), "m1")).not.toBeNull()
            await pmr.remove(did("a"), "m1", "g1")
            expect(await pmr.getMessage(did("a"), "m1")).toBeNull()
            await pmr.remove(did("a"), "m2")
            expect(await pmr.getMessage(did("a"), "m2")).toBeNull()
        })
    })

    it("remove deletes a request entry idempotently and refunds its bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            // The same payload replayed past the nonce window holds one id twice.
            await held(pmr, "a", "m1", 10)
            await held(pmr, "a", "m1", 10)
            await held(pmr, "a", "m2", 20)
            expect(await storageOf(pmr).get("reqBytes")).toBe(40)
            await pmr.remove(did("a"), "m1")
            expect(await storageOf(pmr).get("reqBytes")).toBe(20)
            await pmr.remove(did("a"), "m1")
            await pmr.remove(did("nobody"), "m1")
            expect(await storageOf(pmr).get("reqBytes")).toBe(20)
            expect(await storedRequest(pmr, did("a"))).toEqual([ref("m2", 20)])
        })
    })

    it("removing the last request entry leaves no request mailbox key", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1", 10)
            await held(pmr, "a", "m2", 20)
            await pmr.remove(did("a"), "m1")
            await pmr.remove(did("a"), "m2")
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await storageOf(pmr).get("reqBytes")).toBe(0)
            expect((await pmr.requestMailboxes(null, 10)).entries).toEqual([])
        })
    })

    it("request entries never appear in openMailboxes or list, and do not make hasMailbox true", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1")
            expect(await pmr.openMailboxes(null, 10)).toEqual({ entries: [], nextCursor: null })
            expect(await pmr.list(did("a"), 10)).toEqual([])
            expect(await pmr.hasMailbox(did("a"))).toBe(false)
        })
    })

    it("a request-only sender with a proof row yields no openMailboxes descriptor", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await held(pmr, "a", "m1")
            await storageOf(pmr).put(`pairEvidence:${did("a")}`, {
                senderDID: did("a"),
                anchorKey: new Uint8Array(32),
                declarationCID: "bafy-decl",
                revision: "3kaaaaaaaaaaa",
                car: new Uint8Array(8),
                expiresAt: T0 + 3600,
                generation: "g1",
            })
            expect(await pmr.openMailboxes(null, 10)).toEqual({ entries: [], nextCursor: null })
        })
    })
})

describe("PMRObject.requestMailboxes", () => {
    it("lists each request mailbox's DID with its entry ids oldest first, in key order", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (const [who, id] of [["b", "b1"], ["a", "a1"], ["b", "b2"], ["a", "a2"]] as const) {
                await pmr.appendToRequest(did(who), ref(id), freshNonce(), T0)
            }
            expect(await pmr.requestMailboxes(null, 10)).toEqual({
                entries: [
                    { key: did("a"), messageIds: ["a1", "a2"] },
                    { key: did("b"), messageIds: ["b1", "b2"] },
                ],
                nextCursor: null,
            })
        })
    })

    it("pages by limit and resumes from nextCursor, ending with null", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (const who of ["c", "a", "b"]) {
                await pmr.appendToRequest(did(who), ref(`${who}1`), freshNonce(), T0)
            }
            const first = await pmr.requestMailboxes(null, 2)
            expect(first.entries.map((e) => e.key)).toEqual([did("a"), did("b")])
            expect(first.nextCursor).not.toBeNull()
            const second = await pmr.requestMailboxes(first.nextCursor, 2)
            expect(second.entries.map((e) => e.key)).toEqual([did("c")])
            expect(second.nextCursor).toBeNull()
        })
    })

    it("recovers each sender's DID exactly, colons and all", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const web = "did:web:relay.example:users:eve" as PairMailboxKey
            await pmr.appendToRequest(web, ref("e1"), freshNonce(), T0)
            await pmr.appendToRequest(web, ref("e2"), freshNonce(), T0)
            expect(await pmr.requestMailboxes(null, 10)).toEqual({
                entries: [{ key: web, messageIds: ["e1", "e2"] }],
                nextCursor: null,
            })
        })
    })

    it("lists nothing for a recipient with no request entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.append(did("deep"), ref("m1"), freshNonce(), T0)
            expect(await pmr.requestMailboxes(null, 10)).toEqual({ entries: [], nextCursor: null })
        })
    })
})

describe("request mailbox limits from the environment", () => {
    const withEnv = (pmr: PMRObject, over: Record<string, string | undefined>) => {
        const base = (pmr as unknown as { env: Record<string, unknown> }).env
        Object.defineProperty(pmr, "env", { value: { ...base, ...over }, configurable: true })
    }

    it("uses the configured depth and shared cap", async () => {
        await inPMR(freshStub(), async (pmr) => {
            withEnv(pmr, { REQUEST_DEPTH_PER_SENDER: "2", REQUEST_SHARED_CAP_BYTES: "250" })
            expect((await pmr.appendToRequest(did("a"), ref("m1", 100), freshNonce(), T0)).outcome).toBe("held")
            expect((await pmr.appendToRequest(did("a"), ref("m2", 100), freshNonce(), T0)).outcome).toBe("held")
            expect((await pmr.appendToRequest(did("a"), ref("m3", 100), freshNonce(), T0)).outcome).toBe("refused")
            expect((await pmr.appendToRequest(did("b"), ref("m4", 100), freshNonce(), T0)).outcome).toBe("dropped")
        })
    })

    it.each([undefined, "", "abc", "0", "-3", "1.5"])(
        "bounds the request tier with defaults when a variable is %j",
        async (bad) => {
            await inPMR(freshStub(), async (pmr) => {
                withEnv(pmr, { REQUEST_DEPTH_PER_SENDER: bad, REQUEST_SHARED_CAP_BYTES: bad })
                for (let i = 0; i < 5; i++) {
                    expect((await pmr.appendToRequest(did("a"), ref(`m${i}`, 1), freshNonce(), T0)).outcome).toBe("held")
                }
                expect((await pmr.appendToRequest(did("a"), ref("late", 1), freshNonce(), T0)).outcome).toBe("refused")
                expect((await pmr.appendToRequest(did("big"), ref("big", 5_000_001), freshNonce(), T0)).outcome).toBe("dropped")
                expect((await pmr.appendToRequest(did("fits"), ref("fits", 4_999_995), freshNonce(), T0)).outcome).toBe("held")
                await pmr.block(did("b"), T0)
                let accepted = 0
                for (; accepted < 8; accepted++) {
                    if ((await pmr.receive(did("b"), ref(`b${accepted}`, 1), freshNonce(), T0, { verdict: "no", why: [] })).outcome === "refused") break
                }
                expect(accepted).toBe(5)
            })
        }
    )
})
