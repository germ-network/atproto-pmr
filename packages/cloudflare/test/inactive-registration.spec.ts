/**
 * An inactive registration: terminal, no new mail of any kind, its backlog
 * kept unread until the retention deadline, then destroyed.
 */
import { env, runDurableObjectAlarm } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MessageRef, Nonce } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = Math.floor(Date.now() / 1000)
const DEADLINE = T0 + 30 * 86400

function ref(id: string): MessageRef {
    return { messageId: id, byteLength: 100 }
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
    return testEnv.pmrs.get(testEnv.pmrs.idFromName(`inactive-${counter}`))
}

describe("an inactive registration", () => {
    it("drops a pair put with the uniform 202 and stores nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.markInactive(T0, DEADLINE)
            const r = await pmr.append("did:plc:sender", ref("m1"), freshNonce(), T0)
            expect(r.outcome).toBe("appended")
            expect(r.outcome === "appended" && r.persistBody).toBe(false)
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)
        })
    })

    it("drops an admitted pair put (receive) and stores nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.markInactive(T0, DEADLINE)
            const r = await pmr.receive(
                "did:plc:sender",
                ref("m1"),
                freshNonce(),
                T0,
                { verdict: "yes" }
            )
            expect(r.outcome).toBe("queued")
            expect(r.outcome === "queued" && r.persistBody).toBe(false)
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)
        })
    })

    it("drops a pool put with the uniform 202 and stores nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.markInactive(T0, DEADLINE)
            const r = await pmr.appendToPool("did:plc:sender", ref("p1"), freshNonce(), T0)
            expect(r.outcome).toBe("pooled")
            expect(r.outcome === "pooled" && r.persistBody).toBe(false)
            expect(await pmr.poolSenders()).toHaveLength(0)
        })
    })

    it("drops a grant put to one of its addresses and stores nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.markInactive(T0, DEADLINE)
            const r = await pmr.append("grant:someaddr", ref("g1"), freshNonce(), T0)
            expect(r.outcome).toBe("appended")
            expect(r.outcome === "appended" && r.persistBody).toBe(false)
            expect(await pmr.list("grant:someaddr", 100)).toHaveLength(0)
        })
    })

    it("keeps its stored backlog until the deadline", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.append("did:plc:sender", ref("m1"), freshNonce(), T0)
            await pmr.markInactive(T0, DEADLINE)
            expect((await pmr.list("did:plc:sender", 100)).map((m) => m.messageId)).toEqual(["m1"])
            await pmr.remove("did:plc:sender", "m1")
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)
        })
    })

    it("markInactive is idempotent: the first call's times stand", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await pmr.readInactive()).toBeNull()
            await pmr.markInactive(T0, DEADLINE)
            await pmr.markInactive(T0 + 99, DEADLINE + 99)
            expect(await pmr.readInactive()).toEqual({ inactiveAt: T0, destroyAt: DEADLINE })
        })
    })

    it("its alarm at the retention deadline destroys all of its storage", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.update({ did: "did:plc:x", anchorKey: new Uint8Array(32), lastActive: T0 })
            await pmr.append("did:plc:sender", ref("m1"), freshNonce(), T0)
            await pmr.markInactive(T0, DEADLINE)
        })
        expect(await runDurableObjectAlarm(stub)).toBe(true)
        await inPMR(stub, async (pmr) => {
            expect(await pmr.load()).toBeNull()
            expect(await pmr.readInactive()).toBeNull()
            expect(await pmr.list("did:plc:sender", 100)).toHaveLength(0)
        })
    })

    it("an alarm on an active registration destroys nothing", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.update({ did: "did:plc:x", anchorKey: new Uint8Array(32), lastActive: T0 })
            const held = pmr as unknown as { ctx: DurableObjectState }
            await held.ctx.storage.setAlarm(Date.now() + 3_600_000)
        })
        expect(await runDurableObjectAlarm(stub)).toBe(true)
        await inPMR(stub, async (pmr) => {
            expect(await pmr.load()).not.toBeNull()
        })
    })

    it("destroy also clears a pending alarm", async () => {
        const stub = freshStub()
        await inPMR(stub, async (pmr) => {
            await pmr.markInactive(T0, DEADLINE)
            await pmr.destroy()
        })
        expect(await runDurableObjectAlarm(stub)).toBe(false)
    })
})
