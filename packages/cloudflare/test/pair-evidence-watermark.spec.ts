import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, PairMailboxEvidence } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const NOW = Math.floor(Date.now() / 1000)
const YES: Admission = { verdict: "yes" }
const SENDER = "did:plc:edited-proof" as const
const A: PairMailboxEvidence = { senderDID: SENDER, anchorKey: new Uint8Array(32).fill(1),
    declarationCID: "bafy-a", revision: "3333333333333", car: new Uint8Array([1]), expiresAt: NOW + 3_600 }
const B: PairMailboxEvidence = { ...A, declarationCID: "bafy-b", revision: "4444444444444", car: new Uint8Array([2]) }
const C: PairMailboxEvidence = { ...A, declarationCID: "bafy-c", revision: "5555555555555", car: new Uint8Array([3]) }
const ref = (messageId: string) => ({ messageId, byteLength: 1 })
let counter = 0
const nonce = () => { const bytes = new Uint8Array(16); new DataView(bytes.buffer).setUint32(0, ++counter); return bytes }
const stub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`edited-proof-${++counter}`))
const storageOf = (pmr: PMRObject) => (pmr as unknown as { ctx: DurableObjectState }).ctx.storage
interface Row extends PairMailboxEvidence {
    generation: string
    watermark?: Pick<PairMailboxEvidence, "revision" | "declarationCID" | "anchorKey">
}
const rowOf = (pmr: PMRObject) => storageOf(pmr).get<Row>(`pairEvidence:${SENDER}`)
const watermark = (proof: PairMailboxEvidence) => ({ revision: proof.revision,
    declarationCID: proof.declarationCID, anchorKey: proof.anchorKey })

async function rejectConflicts(pmr: PMRObject, latest: PairMailboxEvidence) {
    for (const conflicting of [A, { ...latest, declarationCID: "bafy-equivocation" },
        { ...latest, anchorKey: new Uint8Array(32).fill(9) }]) {
        const before = await rowOf(pmr)
        expect((await pmr.appendPair(SENDER, ref("rejected"), nonce(), NOW, conflicting)).rejected).toBe("staleEvidence")
        expect(await rowOf(pmr)).toEqual(before)
    }
}

describe("latest declaration watermark versus selected proof", () => {
    it("accepts repeats and replay after same-key edits, retaining one selected CAR and generation", async () => {
        await inPMR(stub(), async pmr => {
            await pmr.provisionFromPool(SENDER, NOW)
            const firstNonce = nonce()
            const first = await pmr.appendPair(SENDER, ref("a"), firstNonce, NOW, A)
            const editedNonce = nonce()
            const edit = await pmr.appendPair(SENDER, ref("b"), editedNonce, NOW, B)
            const repeat = await pmr.appendPair(SENDER, ref("b-again"), nonce(), NOW, B)
            const replay = await pmr.appendPair(SENDER, ref("b"), editedNonce, NOW, B)
            expect(edit.result?.outcome).toBe("appended")
            expect(repeat.result?.outcome).toBe("appended")
            expect(replay.result?.outcome).toBe("duplicate")
            expect(repeat.generation).toBe(first.generation)
            const selected = await pmr.getPairEvidence(SENDER, A.declarationCID, NOW)
            expect(selected).toMatchObject({ car: A.car, revision: A.revision, generation: first.generation })
            expect(await pmr.getPairEvidence(SENDER, B.declarationCID, NOW)).toBeNull()
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(B))
            expect((await storageOf(pmr).list({ prefix: "pairEvidence:" })).size).toBe(1)
            await rejectConflicts(pmr, B)
            expect(await pmr.list(SENDER, 10)).toHaveLength(3)
            const next = await pmr.appendPair(SENDER, ref("c"), nonce(), NOW, C)
            expect(next.result?.outcome).toBe("appended")
            expect(next.evidenceCID).toBe(A.declarationCID)
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(C))
        })
    })

    it.each(["live", "cleared"] as const)("migrates consistent %s legacy rows lazily without replacing their generation", async state => {
        await inPMR(stub(), async pmr => {
            await pmr.provisionFromPool(SENDER, NOW)
            const first = await pmr.appendPair(SENDER, ref("a"), nonce(), NOW, A)
            const storage = storageOf(pmr)
            const { watermark: _, ...legacy } = (await rowOf(pmr))!
            await storage.put(`pairEvidence:${SENDER}`, state === "live" ? legacy : {
                ...legacy, car: new Uint8Array(), expiresAt: 0,
            })
            expect((await pmr.appendPair(SENDER, ref("a-repeat"), nonce(), NOW, A)).result?.outcome).toBe("appended")
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(A))
            expect((await pmr.appendPair(SENDER, ref("b"), nonce(), NOW, B)).result?.outcome).toBe("appended")
            expect((await pmr.appendPair(SENDER, ref("b-repeat"), nonce(), NOW, B)).result?.outcome).toBe("appended")
            expect((await rowOf(pmr))?.generation).toBe(first.generation)
            expect((await rowOf(pmr))?.car).toEqual(A.car)
            expect((await rowOf(pmr))?.declarationCID).toBe(A.declarationCID)
        })
    })

    it("keeps an ambiguous legacy row fail-closed until a newer verified revision recovers it", async () => {
        await inPMR(stub(), async pmr => {
            await pmr.provisionFromPool(SENDER, NOW)
            const replay = nonce()
            const first = await pmr.appendPair(SENDER, ref("a"), replay, NOW, A)
            const { watermark: _, ...legacy } = (await rowOf(pmr))!
            // v0.5.0 advanced revision while losing the edited record CID.
            const ambiguous = { ...legacy, revision: B.revision }
            await storageOf(pmr).put(`pairEvidence:${SENDER}`, ambiguous)
            expect((await pmr.appendPair(SENDER, ref("old"), nonce(), NOW, A)).rejected).toBe("staleEvidence")
            expect((await pmr.appendPair(SENDER, ref("unknown-cid"), nonce(), NOW, B)).rejected).toBe("staleEvidence")
            expect(await rowOf(pmr)).toEqual(ambiguous)
            const recovered = await pmr.appendPair(SENDER, ref("c"), nonce(), NOW, C)
            expect(recovered.result?.outcome).toBe("appended")
            expect(recovered.generation).toBe(first.generation)
            expect(recovered.evidenceCID).toBe(A.declarationCID)
            expect((await pmr.appendPair(SENDER, ref("c-repeat"), nonce(), NOW, C)).result?.outcome).toBe("appended")
            expect((await pmr.appendPair(SENDER, ref("old-replay"), replay, NOW, C)).result?.outcome).toBe("duplicate")
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(C))
            await rejectConflicts(pmr, C)
        })
    })

    it("keeps latest observation across holding, admission and proof expiry, then renews one CAR", async () => {
        await inPMR(stub(), async pmr => {
            const first = await pmr.appendPair(SENDER, ref("a"), nonce(), NOW, A)
            expect(first.result?.outcome).toBe("held")
            expect((await pmr.appendPair(SENDER, ref("b"), nonce(), NOW, B)).result?.outcome).toBe("held")
            expect((await pmr.appendPair(SENDER, ref("b-repeat"), nonce(), NOW, B)).result?.outcome).toBe("held")
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(B))
            expect((await pmr.appendPair(SENDER, ref("opened"), nonce(), NOW, B, YES)).result?.outcome).toBe("queued")
            expect((await pmr.getPairEvidence(SENDER, A.declarationCID, NOW))?.car).toEqual(A.car)
            expect(await pmr.getPairEvidence(SENDER, A.declarationCID, A.expiresAt)).toBeNull()
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(B))
            expect((await pmr.appendPair(SENDER, ref("stale"), nonce(), NOW,
                { ...A, expiresAt: NOW + 7_200 })).rejected).toBe("staleEvidence")
            const renewed = await pmr.appendPair(SENDER, ref("renewed"), nonce(), NOW + 3_601,
                { ...B, expiresAt: NOW + 7_200 })
            expect(renewed.result?.outcome).toBe("appended")
            expect(renewed.generation).toBe(first.generation)
            expect(renewed.evidenceCID).toBe(B.declarationCID)
            expect((await pmr.getPairEvidence(SENDER, B.declarationCID, NOW + 3_601))?.car).toEqual(B.car)
            expect((await storageOf(pmr).list({ prefix: "pairEvidence:" })).size).toBe(1)
        })
    })

    it("retains edited watermark across blocked clearance", async () => {
        await inPMR(stub(), async pmr => {
            await pmr.appendPair(SENDER, ref("a"), nonce(), NOW, A, YES)
            await pmr.appendPair(SENDER, ref("b"), nonce(), NOW, B)
            await pmr.block(SENDER, NOW)
            const after = await pmr.appendPair(SENDER, ref("absorbed"), nonce(), NOW, B)
            expect(after.rejected).toBeUndefined()
            expect((await rowOf(pmr))?.car.byteLength).toBe(0)
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(B))
            await rejectConflicts(pmr, B)
        })
    })

    it("rotates keys on a duplicate, keeps replay protection, and binds the new tuple independently", async () => {
        await inPMR(stub(), async pmr => {
            await pmr.provisionFromPool(SENDER, NOW)
            const replay = nonce()
            const first = await pmr.appendPair(SENDER, ref("a"), replay, NOW, A)
            await pmr.appendPair(SENDER, ref("b"), nonce(), NOW, B)
            const rotatedProof = { ...C, anchorKey: new Uint8Array(32).fill(8) }
            const rotated = await pmr.appendPair(SENDER, ref("a"), replay, NOW, rotatedProof)
            expect(rotated.result?.outcome).toBe("duplicate")
            expect(rotated.generation).not.toBe(first.generation)
            expect(rotated.recycledMessageIds).toContain("a")
            expect(await pmr.list(SENDER, 10)).toEqual([])
            expect((await rowOf(pmr))?.watermark).toEqual(watermark(rotatedProof))
            const accepted = await pmr.appendPair(SENDER, ref("new-key"), nonce(), NOW, rotatedProof)
            expect(accepted.result?.outcome).toBe("appended")
            expect(accepted.generation).toBe(rotated.generation)
            expect((await pmr.getPairEvidence(SENDER, C.declarationCID, NOW))?.car).toEqual(C.car)
            expect((await pmr.appendPair(SENDER, ref("equivocal-key"), nonce(), NOW, C)).rejected).toBe("staleEvidence")
            expect((await pmr.appendPair(SENDER, ref("replay"), replay, NOW, rotatedProof)).result?.outcome).toBe("duplicate")
        })
    })
})
