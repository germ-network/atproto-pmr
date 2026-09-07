/**
 * The own-DID declaration watch as the Durable Object implements it — the two
 * halves that live in this package:
 *
 *   - PAUSE ENFORCEMENT in the admission path: a paused registration absorbs
 *     DID-addressed mail (pair AND pool) — no bytes, no delivery, no nonce
 *     recorded, the same accepted response a real append gives — while
 *     GRANT-addressed mail keeps flowing; and because no nonce is recorded, a
 *     resend after the key returns still lands.
 *   - `applyDeclarationOutcome`: the atomic read-modify-write of the paused
 *     flag a driver calls with a re-check's conclusion.
 *
 * The DRIVER — what re-fetches the declaration and calls
 * `applyDeclarationOutcome` — lives in the deployment (a firehose-fed queue
 * consumer), and is tested there; this package is network-free.
 *
 * Time is injected as a parameter; nothing here measures wall-clock time.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MessageRef, Nonce } from "@germ-network/atproto-pmr-core"
import { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"
import type { PMREnv } from "../src/env"

const testEnv = env as unknown as PMREnv
const T0 = 1_760_000_000

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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`watch-${counter}`))
}

describe("pause enforcement in the admission path", () => {
    it("absorbs a DID-addressed pair put: appended, no bytes, no delivery", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            const r = await pmr.append("did:plc:sender", ref("m1"), freshNonce(), T0)
            expect(r.outcome).toBe("appended")
            expect(r.outcome === "appended" && r.persistBody).toBe(false)
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)
        })
    })

    it("absorbs a DID-addressed pool put: pooled, no bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            const r = await pmr.appendToPool("did:plc:sender", ref("p1"), freshNonce(), T0)
            expect(r.outcome).toBe("pooled")
            expect(r.outcome === "pooled" && r.persistBody).toBe(false)
            expect(await pmr.poolSenders()).toHaveLength(0)
        })
    })

    it("keeps accepting GRANT-addressed mail while paused", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            const r = await pmr.append("grant:someaddr", ref("g1"), freshNonce(), T0)
            expect(r.outcome).toBe("appended")
            expect(r.outcome === "appended" && r.persistBody).toBe(true)
            expect(await pmr.list("grant:someaddr", 100)).toHaveLength(1)
        })
    })

    it("records no nonce on a paused absorb, so a resend after unpause lands", async () => {
        const nonce = freshNonce()
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            await pmr.append("did:plc:sender", ref("m1"), nonce, T0) // absorbed
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)

            // Key returns.
            await pmr.writeWatchState({ paused: false, lastCheckAt: T0 })
            const r = await pmr.append("did:plc:sender", ref("m1"), nonce, T0)
            // Not "duplicate": the nonce was never recorded during the pause.
            expect(r.outcome).toBe("appended")
            expect(r.outcome === "appended" && r.persistBody).toBe(true)
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(1)
        })
    })

    it("a live (unpaused) registration stores normally — the pause is what changes behavior", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const r = await pmr.append("did:plc:sender", ref("m1"), freshNonce(), T0)
            expect(r.outcome === "appended" && r.persistBody).toBe(true)
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(1)
        })
    })
})

describe("applyDeclarationOutcome folds a re-check into the paused flag", () => {
    it("absent pauses", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.applyDeclarationOutcome("absent", T0)
            expect((await pmr.readWatchState()).paused).toBe(true)
        })
    })

    it("present unpauses", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            await pmr.applyDeclarationOutcome("present", T0 + 1)
            expect((await pmr.readWatchState()).paused).toBe(false)
        })
    })

    it("unknown leaves a live mailbox live (a transient failure never pauses)", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.applyDeclarationOutcome("unknown", T0)
            expect((await pmr.readWatchState()).paused).toBe(false)
        })
    })

    it("unknown leaves a paused mailbox paused (recovery needs a confirmed present)", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.writeWatchState({ paused: true, lastCheckAt: T0 })
            await pmr.applyDeclarationOutcome("unknown", T0 + 1)
            expect((await pmr.readWatchState()).paused).toBe(true)
        })
    })
})
