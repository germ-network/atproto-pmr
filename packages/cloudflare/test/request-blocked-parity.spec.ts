/**
 * A blocked sender meets the reservation it would reach unblocked, so the
 * point where a 429 starts cannot tell it that it is blocked.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef, Nonce, PairMailboxEvidence, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = Math.floor(Date.now() / 1000)
const DEPTH = parseInt(testEnv.REQUEST_DEPTH_PER_SENDER)
const CAPACITY = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)

const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["stub"] }
const UNKNOWN: Admission = { verdict: "unknown", why: ["stub"] }
const BLOCKED: Admission = { verdict: "blocked" }

const did = (name: string) => `did:plc:${name}` as PairMailboxKey
const ref = (id: string, byteLength = 100): MessageRef => ({ messageId: id, byteLength })
const evidence = (who: PairMailboxKey): PairMailboxEvidence => ({
    senderDID: who,
    anchorKey: new Uint8Array(32).fill(7),
    declarationCID: "bafy-selected",
    revision: "5555555555555",
    car: new Uint8Array(1000),
    expiresAt: T0 + 3_600,
})

let nonceCounter = 0
const freshNonce = (): Nonce => {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}
let counter = 0
const freshStub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`request-blocked-${++counter}`))
const storageOf = (pmr: PMRObject) => (pmr as unknown as { db: DurableObjectStorage }).db
const reqBytes = async (pmr: PMRObject) => (await storageOf(pmr).get<number>("reqBytes")) ?? 0

/** Every storage operation issued while `fn` runs, as `op:keyFamily`. */
async function traceStorage(pmr: PMRObject, fn: () => Promise<unknown>): Promise<string[]> {
    const target = storageOf(pmr)
    const ops: string[] = []
    const traced = new Proxy(target, {
        get(t, prop) {
            const value = (t as unknown as Record<string | symbol, unknown>)[prop]
            if (typeof value !== "function") return value
            return (...args: unknown[]) => {
                const first = args[0]
                ops.push(`${String(prop)}:${typeof first === "string" ? first.split(":")[0] : "-"}`)
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

/** How many puts a sender gets through before the first refusal. */
async function acceptedBeforeRefusal(put: (i: number) => Promise<string>, limit: number): Promise<number> {
    for (let i = 0; i < limit; i++) {
        if ((await put(i)) === "refused") return i
    }
    return limit
}

describe("synthetic capacity follows the tier", () => {
    it("refuses a device-blocked sender judged no at the request depth", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(did("a"), T0)
            const accepted = await acceptedBeforeRefusal(
                async (i) => (await pmr.receive(did("a"), ref(`m${i}`), freshNonce(), T0, NO)).outcome,
                CAPACITY + 2
            )
            expect(accepted).toBe(DEPTH)
            await pmr.block(did("b"), T0)
            expect(
                await acceptedBeforeRefusal(
                    async (i) => (await pmr.receive(did("b"), ref(`m${i}`), freshNonce(), T0, UNKNOWN)).outcome,
                    CAPACITY + 2
                )
            ).toBe(DEPTH)
        })
    })

    it("refuses a device-blocked sender judged yes at the pair depth", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(did("a"), T0)
            const accepted = await acceptedBeforeRefusal(
                async (i) => (await pmr.receive(did("a"), ref(`m${i}`), freshNonce(), T0, YES)).outcome,
                CAPACITY + 2
            )
            expect(accepted).toBe(CAPACITY)
        })
    })

    it("refuses a Bsky-blocked sender at the request depth", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const accepted = await acceptedBeforeRefusal(
                async (i) => (await pmr.receive(did("a"), ref(`m${i}`), freshNonce(), T0, BLOCKED)).outcome,
                CAPACITY + 2
            )
            expect(accepted).toBe(DEPTH)
            expect(await pmr.listBskyBlocked()).toEqual([did("a")])
        })
    })

    it("refuses a blocked sender on the no-admission path at the request depth", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(did("a"), T0)
            const accepted = await acceptedBeforeRefusal(
                async (i) =>
                    (await pmr.appendPair(did("a"), ref(`m${i}`), freshNonce(), T0, evidence(did("a")))).result?.outcome ?? "none",
                CAPACITY + 2
            )
            expect(accepted).toBe(DEPTH)
        })
    })

    it("keeps the pair depth for a blocked grant key", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block("grant:abc", T0)
            const accepted = await acceptedBeforeRefusal(
                async (i) => (await pmr.append("grant:abc", ref(`m${i}`), freshNonce(), T0)).outcome,
                CAPACITY + 2
            )
            expect(accepted).toBe(CAPACITY)
        })
    })

    it("blocking a sender clears its request entries and refunds their bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendPair(did("other"), ref("o1"), freshNonce(), T0, evidence(did("other")))
            await pmr.appendPair(did("a"), ref("m1"), freshNonce(), T0, evidence(did("a")))
            await pmr.appendPair(did("a"), ref("m2"), freshNonce(), T0, evidence(did("a")))
            expect(await reqBytes(pmr)).toBe(1100 + 1200)
            await pmr.block(did("a"), T0)
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await pmr.getMessage(did("a"), "m1")).toBeNull()
            expect((await pmr.requestMailboxes(null, 10)).entries.map((e) => e.key)).toEqual([did("other")])
            expect(await reqBytes(pmr)).toBe(1100)
            // The proof row survives as the sender's anti-rollback watermark.
            const watermark = await storageOf(pmr).get<{ car: Uint8Array; expiresAt: number; requestAccountedBytes?: number }>(`pairEvidence:${did("a")}`)
            expect(watermark?.car.byteLength).toBe(0)
            expect(watermark?.expiresAt).toBe(0)
            expect(watermark?.requestAccountedBytes ?? 0).toBe(0)
        })
    })

    it("blocking an already-blocked sender clears request entries that landed after the block", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.block(did("a"), T0)
            await storageOf(pmr).put(`req:${did("a")}`, [ref("late")])
            await storageOf(pmr).put("reqBytes", 100)
            await pmr.block(did("a"), T0)
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(0)
        })
    })

    it("a blocked sender's put reads the request mailbox, quota and pair mailbox as an unblocked sender's does", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const families = ["req", "reqBytes", "mbox"]
            const reads = (ops: string[]) => ops.filter((op) => op.startsWith("get:") && families.includes(op.slice(4))).sort()
            const unblocked = await traceStorage(pmr, () => pmr.receive(did("a"), ref("m1"), freshNonce(), T0, NO))
            await pmr.block(did("b"), T0)
            const blocked = await traceStorage(pmr, () => pmr.receive(did("b"), ref("m1"), freshNonce(), T0, NO))
            expect(reads(blocked)).toEqual(reads(unblocked))
            expect(reads(unblocked)).toHaveLength(3)
        })
    })

    it("syncBskyBlocks blocks a Bsky-blocked sender that holds only request entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(did("a"), ref("m1"), freshNonce(), T0, NO)
            await pmr.receive(did("kept"), ref("k1"), freshNonce(), T0, NO)
            await pmr.syncBskyBlocks(new Set([did("a")]))
            expect(await pmr.listBskyBlocked()).toEqual([did("a")])
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect((await pmr.requestMailboxes(null, 10)).entries.map((e) => e.key)).toEqual([did("kept")])
        })
    })
})
