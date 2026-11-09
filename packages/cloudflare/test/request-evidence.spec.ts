/**
 * A request sender's proof counts against the shared request quota with its
 * entries: held together or not at all, served while its entries are held,
 * and gone with them.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef, Nonce, PairMailboxEvidence, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const T0 = Math.floor(Date.now() / 1000)
const CAP = parseInt(testEnv.REQUEST_SHARED_CAP_BYTES)
const CAPACITY = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["stub"] }

const did = (name: string) => `did:plc:${name}` as PairMailboxKey
const ref = (id: string, byteLength = 100): MessageRef => ({ messageId: id, byteLength })
const evidence = (who: PairMailboxKey, carBytes = 1000, over: Partial<PairMailboxEvidence> = {}): PairMailboxEvidence => ({
    senderDID: who,
    anchorKey: new Uint8Array(32).fill(7),
    declarationCID: "bafy-selected",
    revision: "5555555555555",
    car: new Uint8Array(carBytes).fill(7),
    expiresAt: T0 + 3_600,
    ...over,
})

let nonceCounter = 0
const freshNonce = (): Nonce => {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}
let counter = 0
const freshStub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`request-evidence-${++counter}`))
const storageOf = (pmr: PMRObject) => (pmr as unknown as { db: DurableObjectStorage }).db
interface ProofRow {
    car: Uint8Array
    expiresAt: number
    requestAccountedBytes?: number
}
const row = (pmr: PMRObject, who: PairMailboxKey) => storageOf(pmr).get<ProofRow>(`pairEvidence:${who}`)
const reqBytes = async (pmr: PMRObject) => (await storageOf(pmr).get<number>("reqBytes")) ?? 0
const heldBy = (pmr: PMRObject, who: PairMailboxKey, id: string, admission?: Admission, over: Partial<PairMailboxEvidence> = {}, bytes = 100) =>
    pmr.appendPair(who, ref(id, bytes), freshNonce(), T0, evidence(who, 1000, over), admission)

describe("request-sender pair evidence", () => {
    const expireProof = async (pmr: PMRObject, who: PairMailboxKey) => {
        const stored = (await row(pmr, who))!
        await storageOf(pmr).put(`pairEvidence:${who}`, { ...stored, expiresAt: T0 - 1 })
    }

    it("holds a first-contact request entry and its proof when both fit the shared quota", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const pair = await heldBy(pmr, did("a"), "m1")
            expect(pair.result).toEqual({ outcome: "held" })
            expect((await row(pmr, did("a")))?.car.byteLength).toBe(1000)
            expect((await row(pmr, did("a")))?.requestAccountedBytes).toBe(1000)
            expect(await reqBytes(pmr)).toBe(1100)
        })
    })

    it("drops a first contact whose entry and proof do not fit, writing no evidence row", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToRequest(did("filler"), ref("fill", CAP - 500), freshNonce(), T0)
            const nonce = freshNonce()
            const pair = await pmr.appendPair(did("a"), ref("m1"), nonce, T0, evidence(did("a")))
            expect(pair.result).toEqual({ outcome: "dropped" })
            expect(await row(pmr, did("a"))).toBeUndefined()
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(CAP - 500)
            // Nothing was consumed, so the same put is judged afresh once room exists.
            await pmr.remove(did("filler"), "fill")
            expect((await pmr.appendPair(did("a"), ref("m1"), nonce, T0, evidence(did("a")))).result).toEqual({ outcome: "held" })
        })
    })

    it("charges only the entry bytes when the sender's live proof is already held", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await heldBy(pmr, did("a"), "m2", undefined, {}, 50)
            expect(await reqBytes(pmr)).toBe(1150)
            expect((await row(pmr, did("a")))?.requestAccountedBytes).toBe(1000)
        })
    })

    it("binds held request refs to the pair generation and declaration hint", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            const second = await heldBy(pmr, did("a"), "m2")
            const refs = (await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`))!
            expect(refs).toHaveLength(2)
            for (const held of refs) {
                expect(held.pairGeneration).toBe(second.generation)
                expect(held.hint).toEqual({ senderDID: did("a"), declarationCID: "bafy-selected" })
            }
        })
    })

    it("getPairEvidence serves a request-only sender's proof", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const proof = evidence(did("a"))
            await pmr.appendPair(did("a"), ref("m1"), freshNonce(), T0, proof)
            expect((await pmr.getPairEvidence(did("a"), proof.declarationCID, T0))?.car).toEqual(proof.car)
            expect(await pmr.getPairEvidence(did("a"), "bafy-other", T0)).toBeNull()
            expect(await pmr.getPairEvidence(did("nobody"), proof.declarationCID, T0)).toBeNull()
        })
    })

    it("removing a request-only sender's last entry deletes its evidence row and refunds the proof bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await heldBy(pmr, did("a"), "m2")
            await pmr.remove(did("a"), "m1")
            expect(await row(pmr, did("a"))).toBeDefined()
            await pmr.remove(did("a"), "m2")
            expect(await row(pmr, did("a"))).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(0)
        })
    })

    it("proof expiry for a request-only sender deletes its entries and evidence row and refunds their bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await heldBy(pmr, did("live"), "l1")
            await expireProof(pmr, did("a"))
            await pmr.alarm()
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await row(pmr, did("a"))).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(1100)
            expect((await pmr.requestMailboxes(null, 10)).entries.map((e) => e.key)).toEqual([did("live")])
        })
    })

    it("openMailboxes applies the same expiry purge to a request-only sender it meets", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await heldBy(pmr, did("live"), "l1")
            await expireProof(pmr, did("a"))
            expect(await pmr.openMailboxes(null, 10)).toEqual({ entries: [], nextCursor: null })
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await row(pmr, did("a"))).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(1100)
        })
    })

    it("getPairEvidence at expiry purges a request-only sender's entries and row and refunds their bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await heldBy(pmr, did("live"), "l1")
            expect(await pmr.getPairEvidence(did("a"), "bafy-selected", T0 + 3_600)).toBeNull()
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await row(pmr, did("a"))).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(1100)
        })
    })

    it("a put meeting its sender's expired proof purges the stale request entries before judging", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < 5; i++) await heldBy(pmr, did("a"), `old${i}`, undefined, {}, 10)
            await expireProof(pmr, did("a"))
            const fresh = await pmr.appendPair(did("a"), ref("fresh"), freshNonce(), T0, evidence(did("a"), 1000, { revision: "6666666666666" }))
            expect(fresh.result).toEqual({ outcome: "held" })
            expect(((await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`)) ?? []).map((r) => r.messageId)).toEqual(["fresh"])
            expect(await reqBytes(pmr)).toBe(1100)
        })
    })

    it("proof expiry for a sender holding both tiers refunds its request accounting and keeps its request entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("other"), "o1")
            for (const id of ["r1", "r2", "r3", "r4"]) await heldBy(pmr, did("a"), id)
            for (let i = 0; i < CAPACITY - 3; i++) await pmr.append(did("a"), ref(`d${i}`), freshNonce(), T0)
            await heldBy(pmr, did("a"), "new", YES)
            expect(await reqBytes(pmr)).toBe(1100 + 1000 + 200)
            await expireProof(pmr, did("a"))
            await pmr.alarm()
            expect(await reqBytes(pmr)).toBe(1100 + 200)
            expect(((await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`)) ?? []).map((r) => r.messageId)).toEqual(["r3", "r4"])
            expect((await row(pmr, did("a")))?.car.byteLength).toBe(0)
        })
    })

    it("removing the last request entry of a blocked sender keeps its anti-rollback watermark row", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("a"), "m1")
            await pmr.block(did("a"), T0)
            await pmr.remove(did("a"), "m1")
            expect(await row(pmr, did("a"))).toMatchObject({ expiresAt: 0 })
            expect(await reqBytes(pmr)).toBe(0)
        })
    })

    it("moving every request entry on admission releases the proof from the shared quota", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("other"), "o1")
            await heldBy(pmr, did("a"), "m1")
            expect(await reqBytes(pmr)).toBe(2200)
            expect((await heldBy(pmr, did("a"), "m2", YES)).result).toMatchObject({ outcome: "queued" })
            expect(await reqBytes(pmr)).toBe(1100)
            expect((await row(pmr, did("a")))?.requestAccountedBytes ?? 0).toBe(0)
            expect((await pmr.getPairEvidence(did("a"), "bafy-selected", T0))?.car.byteLength).toBe(1000)
        })
    })

    it("emptying the request mailbox of a sender that also holds a pair mailbox keeps the proof and zeroes its request accounting, so a later clear refunds nothing twice", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await heldBy(pmr, did("other"), "o1")
            for (const id of ["r1", "r2", "r3", "r4"]) await heldBy(pmr, did("a"), id)
            for (let i = 0; i < CAPACITY - 3; i++) await pmr.append(did("a"), ref(`d${i}`), freshNonce(), T0)
            const admitted = await heldBy(pmr, did("a"), "new", YES)
            expect(admitted.result).toMatchObject({ outcome: "queued", moved: [ref("r1"), ref("r2")] })
            expect((await row(pmr, did("a")))?.requestAccountedBytes).toBe(1000)
            await pmr.remove(did("a"), "r3")
            await pmr.remove(did("a"), "r4")
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect(await row(pmr, did("a"))).toMatchObject({ requestAccountedBytes: 0 })
            expect((await row(pmr, did("a")))?.car.byteLength).toBe(1000)
            expect(await reqBytes(pmr)).toBe(1100)
            // The later clear (proof expiry) must not refund the already-released proof.
            expect(await pmr.getPairEvidence(did("a"), "bafy-selected", T0 + 3_600)).toBeNull()
            expect(await reqBytes(pmr)).toBe(1100)
        })
    })

    it("a request entry held without evidence stays until acked, moved or blocked", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendToRequest(did("a"), ref("m1"), freshNonce(), T0)
            expect(await row(pmr, did("a"))).toBeUndefined()
            await pmr.alarm()
            await pmr.openMailboxes(null, 10)
            expect(await pmr.getMessage(did("a"), "m1")).toEqual(ref("m1"))
            expect((await pmr.requestMailboxes(null, 10)).entries).toEqual([{ key: did("a"), messageIds: ["m1"] }])
            await pmr.remove(did("a"), "m1")
            expect(await pmr.getMessage(did("a"), "m1")).toBeNull()
        })
    })

    it("a sender key change recycles request entries with the pair entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            const deep = await pmr.appendPair(did("a"), ref("deep"), freshNonce(), T0, evidence(did("a")), YES)
            expect(deep.result).toMatchObject({ outcome: "queued" })
            await pmr.appendPair(did("a"), ref("held"), freshNonce(), T0, evidence(did("a")), NO)
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeDefined()
            const rotated = await pmr.appendPair(
                did("a"), ref("after"), freshNonce(), T0,
                evidence(did("a"), 1000, { anchorKey: new Uint8Array(32).fill(8), revision: "6666666666666", declarationCID: "bafy-rotated" }),
                NO
            )
            expect(rotated.generationChanged).toBe(true)
            expect([...rotated.recycledMessageIds].sort()).toEqual(["deep", "held"])
            expect(await pmr.list(did("a"), 10)).toEqual([])
            const kept = (await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`))!
            expect(kept.map((r) => r.messageId)).toEqual(["after"])
            expect(await reqBytes(pmr)).toBe(100)
        })
    })
})
