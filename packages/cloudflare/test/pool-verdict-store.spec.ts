/**
 * The store keeps each pooled sender's latest verdict exactly as long as it
 * keeps the sender's pool entries.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MessageRef, Nonce, PoolVerdict } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = 1_760_000_000
const SENDER = "did:plc:mallory"

const NO: PoolVerdict = { verdict: "no", why: ["not-admitted"] }
const UNKNOWN: PoolVerdict = { verdict: "unknown", why: ["graph-incomplete", "block-unknown"] }

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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`pool-verdict-${counter}`))
}

describe("PMRObject pool verdicts", () => {
    it("a pooled put records its verdict, listed by poolSenders", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToPool(SENDER, ref("m1"), freshNonce(), T0, NO)
            expect(await pmr.poolSenders()).toEqual([{ did: SENDER, count: 1, verdict: NO }])
        })
    })

    it("a sender pooled without a verdict lists without one", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToPool(SENDER, ref("m1"), freshNonce(), T0)
            expect(await pmr.poolSenders()).toEqual([{ did: SENDER, count: 1 }])
        })
    })

    it("a later pooled put replaces the recorded verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToPool(SENDER, ref("m1"), freshNonce(), T0, NO)
            await pmr.appendToPool(SENDER, ref("m2"), freshNonce(), T0, UNKNOWN)
            expect(await pmr.poolSenders()).toEqual([{ did: SENDER, count: 2, verdict: UNKNOWN }])
        })
    })

    it("a discarded or duplicate put does not change the recorded verdict", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const nonce = freshNonce()
            await pmr.appendToPool(SENDER, ref("m1"), nonce, T0, NO)
            const duplicate = await pmr.appendToPool(SENDER, ref("m1"), nonce, T0, UNKNOWN)
            expect(duplicate.outcome).toBe("duplicate")
            expect((await pmr.poolSenders())[0]!.verdict).toEqual(NO)

            await pmr.setDiscarded(SENDER, T0 + 100)
            const discarded = await pmr.appendToPool(SENDER, ref("m3"), freshNonce(), T0, UNKNOWN)
            expect(discarded).toEqual({ outcome: "pooled", persistBody: false })
            expect((await pmr.poolSenders())[0]!.verdict).toEqual(NO)
        })
    })

    it("provision, discard and block drop the recorded verdict with the pool entries", async () => {
        const gone = async (act: (pmr: PMRObject) => Promise<unknown>) =>
            inPMR(freshStub(), async (pmr) => {
                await pmr.appendToPool(SENDER, ref("m1"), freshNonce(), T0, NO)
                await act(pmr as unknown as PMRObject)
                expect(await pmr.poolSenders()).toEqual([])
                // Pooled again without a verdict: no stale one resurfaces.
                await pmr.setDiscarded(SENDER, 0)
                await pmr.appendToPool(SENDER, ref("m2"), freshNonce(), T0 + 1)
                expect(await pmr.poolSenders()).toEqual([{ did: SENDER, count: 1 }])
            })
        await gone((pmr) => pmr.provisionFromPool(SENDER, T0))
        await gone((pmr) => pmr.discardFromPool(SENDER, T0 + 100))
        await gone((pmr) => pmr.block(SENDER, T0))
    })
})
