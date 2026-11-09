/**
 * Every non-blocked pair put is judged by admission on its own: a yes goes
 * to the sender's pair mailbox, anything else to its request mailbox. A
 * relay with no admission source admits nobody.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef, Nonce, PairMailboxEvidence, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = Math.floor(Date.now() / 1000)
const CAPACITY = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)

const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["stub"] }
const UNKNOWN: Admission = { verdict: "unknown", why: ["stub"] }

const did = (name: string) => `did:plc:${name}` as PairMailboxKey
const ref = (id: string, byteLength = 100): MessageRef => ({ messageId: id, byteLength })
const evidence = (senderDID: PairMailboxKey): PairMailboxEvidence => ({
    senderDID,
    anchorKey: new Uint8Array(32).fill(7),
    declarationCID: "bafy-selected",
    revision: "5555555555555",
    car: new Uint8Array([7]),
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
const freshStub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`request-routing-${++counter}`))
const storageOf = (pmr: PMRObject) => (pmr as unknown as { db: DurableObjectStorage }).db
const requestIds = async (pmr: PMRObject, who: PairMailboxKey) =>
    ((await storageOf(pmr).get<MessageRef[]>(`req:${who}`)) ?? []).map((r) => r.messageId)
const deepIds = async (pmr: PMRObject, who: PairMailboxKey) =>
    (await pmr.list(who, 100)).map((r) => r.messageId)

describe("PMRObject.receive routing", () => {
    it("holds a no or unknown put in the request mailbox", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await pmr.receive(did("a"), ref("a1"), freshNonce(), T0, NO)).toEqual({ outcome: "held" })
            expect(await pmr.receive(did("b"), ref("b1"), freshNonce(), T0, UNKNOWN)).toEqual({ outcome: "held" })
            expect(await requestIds(pmr, did("a"))).toEqual(["a1"])
            expect(await requestIds(pmr, did("b"))).toEqual(["b1"])
            expect(await pmr.hasMailbox(did("a"))).toBe(false)
        })
    })

    it("holds a no put in the request mailbox even when the sender has a pair mailbox", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect((await pmr.receive(did("a"), ref("deep"), freshNonce(), T0, YES)).outcome).toBe("queued")
            expect(await pmr.receive(did("a"), ref("later"), freshNonce(), T0, NO)).toEqual({ outcome: "held" })
            expect(await deepIds(pmr, did("a"))).toEqual(["deep"])
            expect(await requestIds(pmr, did("a"))).toEqual(["later"])
        })
    })

    it("judges a put to a pair mailbox opened before this release like any other", async () => {
        await inPMR(freshStub(), async (pmr) => {
            // Every pair mailbox is judged on every put, however it was opened.
            await pmr.append(did("old"), ref("existing"), freshNonce(), T0)
            expect(await pmr.receive(did("old"), ref("n1"), freshNonce(), T0, NO)).toEqual({ outcome: "held" })
            expect(await deepIds(pmr, did("old"))).toEqual(["existing"])
            expect((await pmr.receive(did("old"), ref("n2"), freshNonce(), T0, YES)).outcome).toBe("queued")
            expect(await deepIds(pmr, did("old"))).toEqual(["existing", "n1", "n2"])
        })
    })

    it("opens the pair mailbox on yes and moves request entries in ahead of the put, oldest first", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (const id of ["r1", "r2", "r3"]) await pmr.receive(did("a"), ref(id, 10), freshNonce(), T0, NO)
            const result = await pmr.receive(did("a"), ref("new", 10), freshNonce(), T0, YES)
            expect(result).toEqual({
                outcome: "queued",
                persistBody: true,
                moved: [ref("r1", 10), ref("r2", 10), ref("r3", 10)],
            })
            expect(await deepIds(pmr, did("a"))).toEqual(["r1", "r2", "r3", "new"])
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await storageOf(pmr).get("reqBytes")).toBe(0)
        })
    })

    it("moves only as many request entries as the pair mailbox has room for, leaving the rest held", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY - 3; i++) await pmr.append(did("a"), ref(`d${i}`), freshNonce(), T0)
            for (const id of ["r1", "r2", "r3", "r4"]) await pmr.receive(did("a"), ref(id, 10), freshNonce(), T0, NO)
            const result = await pmr.receive(did("a"), ref("new", 10), freshNonce(), T0, YES)
            expect(result).toMatchObject({ outcome: "queued", moved: [ref("r1", 10), ref("r2", 10)] })
            const deep = await deepIds(pmr, did("a"))
            expect(deep).toHaveLength(CAPACITY)
            expect(deep.slice(-3)).toEqual(["r1", "r2", "new"])
            expect(await requestIds(pmr, did("a"))).toEqual(["r3", "r4"])
            expect(await storageOf(pmr).get("reqBytes")).toBe(20)
        })
    })

    it("a moved entry keeps its id, body and fields", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const original: MessageRef = {
                messageId: "r1",
                byteLength: 42,
                hint: { senderDID: did("a"), declarationCID: "bafy-selected" },
                ext: { flag: true },
                pairGeneration: "g1",
            }
            await pmr.receive(did("a"), original, freshNonce(), T0, NO)
            await pmr.receive(did("a"), ref("new"), freshNonce(), T0, YES)
            expect(await pmr.getMessage(did("a"), "r1")).toEqual(original)
            expect(await deepIds(pmr, did("a"))).toEqual(["r1", "new"])
        })
    })

    it("refuses a yes whose own ref does not fit, moving nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < CAPACITY; i++) await pmr.append(did("a"), ref(`d${i}`), freshNonce(), T0)
            await pmr.receive(did("a"), ref("r1", 10), freshNonce(), T0, NO)
            const nonce = freshNonce()
            const result = await pmr.receive(did("a"), ref("new"), nonce, T0, YES)
            expect(result).toEqual({ outcome: "refused", retryAfter: expect.any(Number) })
            expect(await requestIds(pmr, did("a"))).toEqual(["r1"])
            expect(await deepIds(pmr, did("a"))).toHaveLength(CAPACITY)
            // The refusal consumed nothing, so a retry is judged afresh.
            await pmr.remove(did("a"), "d0")
            expect((await pmr.receive(did("a"), ref("new"), nonce, T0, YES)).outcome).toBe("queued")
        })
    })

    it("never writes an admitted mark", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(did("a"), ref("r1"), freshNonce(), T0, NO)
            await pmr.receive(did("a"), ref("new"), freshNonce(), T0, YES)
            await pmr.receive(did("b"), ref("b1"), freshNonce(), T0, YES)
            expect([...(await storageOf(pmr).list({ prefix: "adm:" })).keys()]).toEqual([])
        })
    })

    it("a sender whose request mailbox emptied is judged by admission again on its next put", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(did("a"), ref("r1"), freshNonce(), T0, NO)
            await pmr.remove(did("a"), "r1")
            expect(await pmr.receive(did("a"), ref("r2"), freshNonce(), T0, NO)).toEqual({ outcome: "held" })
            await pmr.remove(did("a"), "r2")
            expect(await pmr.receive(did("a"), ref("r3"), freshNonce(), T0, YES)).toEqual({
                outcome: "queued",
                persistBody: true,
            })
        })
    })

    it("answers duplicate to a yes put whose id a request mailbox already holds, moving nothing", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.receive(did("a"), ref("same"), freshNonce(), T0, NO)
            expect(await pmr.receive(did("a"), ref("same"), freshNonce(), T0, YES)).toEqual({ outcome: "duplicate" })
            expect(await requestIds(pmr, did("a"))).toEqual(["same"])
            expect(await pmr.hasMailbox(did("a"))).toBe(false)
        })
    })
})

describe("PMRObject.appendPair without admission", () => {
    it("holds a sender with no pair mailbox in the request mailbox", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const pair = await pmr.appendPair(did("a"), ref("m1"), freshNonce(), T0, evidence(did("a")))
            expect(pair.result).toEqual({ outcome: "held" })
            expect(await requestIds(pmr, did("a"))).toEqual(["m1"])
            expect(await pmr.hasMailbox(did("a"))).toBe(false)
        })
    })

    it("appends to a pair mailbox an earlier admission opened", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendPair(did("a"), ref("m1"), freshNonce(), T0, evidence(did("a")), YES)
            const pair = await pmr.appendPair(did("a"), ref("m2"), freshNonce(), T0, evidence(did("a")))
            expect(pair.result).toMatchObject({ outcome: "appended" })
            expect(await deepIds(pmr, did("a"))).toEqual(["m1", "m2"])
            expect(await requestIds(pmr, did("a"))).toEqual([])
        })
    })
})
