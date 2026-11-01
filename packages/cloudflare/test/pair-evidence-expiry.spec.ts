import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { PairMailboxEvidence, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const NOW = Math.floor(Date.now() / 1000)
let counter = 0
const freshStub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`proof-expiry-${++counter}`))
const nonce = () => { const n = new Uint8Array(16); new DataView(n.buffer).setUint32(0, ++counter); return n }
const ref = (messageId: string) => ({ messageId, byteLength: 1 })
const evidence = (senderDID: PairMailboxKey, expiresAt = NOW + 3_600): PairMailboxEvidence => ({
    senderDID, anchorKey: new Uint8Array(32).fill(7), declarationCID: "bafy-selected",
    revision: "5555555555555", car: new Uint8Array([7]), expiresAt,
})
const storageOf = (pmr: PMRObject) => (pmr as unknown as { ctx: DurableObjectState }).ctx.storage
interface ProofRow {
    car: Uint8Array
    expiresAt: number
    generation: string
    revision: string
    anchorKey: Uint8Array
}

// Exercise actual Worker storage and its invalid-alarm/input-gate behavior.
describe("cleared pair-proof watermarks", () => {
    it.each(["blocked", "discarded"] as const)("keeps a %s sender's watermark without scheduling expiry and permits later recovery", async action => {
        const stub = freshStub()
        const sender = `did:plc:watermark-${action}` as const
        const proof = evidence(sender)
        await inPMR(stub, async pmr => {
            if (action === "blocked") await pmr.provisionFromPool(sender, NOW)
            const first = await pmr.appendPair(sender, ref("first"), nonce(), NOW, proof)
            expect(first.result?.outcome).toBe(action === "blocked" ? "appended" : "pooled")
            if (action === "blocked") await pmr.block(sender, NOW)
            else await pmr.discardFromPool(sender, NOW + 100)
            const storage = storageOf(pmr)
            await storage.deleteAlarm() // Consume the earlier live-proof alarm.
            const cleared = await storage.get<ProofRow>(`pairEvidence:${sender}`)
            expect(cleared?.car.byteLength).toBe(0)
            expect(cleared?.expiresAt).toBe(0)
            const refused = await pmr.appendPair(sender, ref("absorbed"), nonce(), NOW, proof)
            expect(refused.rejected).toBeUndefined()
            expect(refused.result).not.toMatchObject({ persistBody: true })
            expect(await pmr.list(sender, 10)).toEqual([])
            expect(await pmr.poolSenders()).toEqual([])
            expect(await storage.getAlarm()).toBeNull()
            expect(await storage.get(`pairEvidence:${sender}`)).toEqual(cleared)
            const stale = await pmr.appendPair(sender, ref("stale"), nonce(), NOW,
                { ...proof, revision: "4444444444444" })
            expect(stale.rejected).toBe("staleEvidence")
            expect(await storage.get(`pairEvidence:${sender}`)).toEqual(cleared)

            if (action === "blocked") await pmr.unblock(sender)
            await pmr.provisionFromPool(sender, NOW + 101)
            const recovered = await pmr.appendPair(sender, ref("recovered"), nonce(), NOW + 101,
                { ...proof, revision: "6666666666666" })
            expect(recovered.result?.outcome).toBe("appended")
            expect(recovered.generation).toBe(first.generation)
            expect((await pmr.getPairEvidence(sender, proof.declarationCID, NOW + 101))?.car).toEqual(proof.car)
            expect(await storage.getAlarm()).toBe(proof.expiresAt * 1000)
        })
        // A later RPC still works: an invalid setAlarm inside appendPair would
        // instead break the Durable Object's input gate.
        await expect(stub.hasMailbox(sender)).resolves.toBe(true)
    })

    it.each(["read", "alarm"] as const)("a duplicate after %s expiry keeps the watermark and does not recreate an alarm", async expiry => {
        const stub = freshStub()
        const sender = `did:plc:watermark-${expiry}` as const
        const proof = evidence(sender)
        const replay = nonce()
        await inPMR(stub, async pmr => {
            await pmr.provisionFromPool(sender, NOW)
            const first = await pmr.appendPair(sender, ref("same-id"), replay, NOW, proof)
            const storage = storageOf(pmr)
            await storage.deleteAlarm()
            if (expiry === "read") {
                expect(await pmr.getPairEvidence(sender, proof.declarationCID, proof.expiresAt)).toBeNull()
            } else {
                const row = await storage.get<ProofRow>(`pairEvidence:${sender}`)
                await storage.put(`pairEvidence:${sender}`, { ...row, expiresAt: NOW - 1 })
                await pmr.alarm()
            }
            const cleared = await storage.get<ProofRow>(`pairEvidence:${sender}`)
            expect(cleared?.expiresAt).toBe(0)
            expect(cleared?.car.byteLength).toBe(0)
            const nextProof = { ...proof, expiresAt: NOW + 7_200 }
            const duplicate = await pmr.appendPair(sender, ref("same-id"), replay, NOW + 3_601, nextProof)
            expect(duplicate.result?.outcome).toBe("duplicate")
            expect(duplicate.generation).toBe(first.generation)
            expect(await storage.getAlarm()).toBeNull()
            expect(await storage.get(`pairEvidence:${sender}`)).toEqual(cleared)
            const stale = await pmr.appendPair(sender, ref("stale"), nonce(), NOW + 3_601,
                { ...nextProof, revision: "4444444444444" })
            expect(stale.rejected).toBe("staleEvidence")
            const accepted = await pmr.appendPair(sender, ref("renewed"), nonce(), NOW + 3_601, nextProof)
            expect(accepted.result?.outcome).toBe("appended")
            expect(accepted.generation).toBe(first.generation)
            expect(await storage.getAlarm()).toBe(nextProof.expiresAt * 1000)
            expect((await pmr.getPairEvidence(sender, proof.declarationCID, NOW + 3_601))?.car).toEqual(proof.car)
        })
    })

    it("does not replace another live proof's earlier alarm with a cleared watermark", async () => {
        const stub = freshStub()
        const clearedSender = "did:plc:watermark-cleared" as const
        const liveSender = "did:plc:watermark-live" as const
        await inPMR(stub, async pmr => {
            await pmr.provisionFromPool(clearedSender, NOW)
            const clearedProof = evidence(clearedSender)
            await pmr.appendPair(clearedSender, ref("clear-me"), nonce(), NOW, clearedProof)
            await pmr.block(clearedSender, NOW)
            await storageOf(pmr).deleteAlarm()
            const live = evidence(liveSender, NOW + 100)
            await pmr.appendPair(liveSender, ref("live"), nonce(), NOW, live)
            await pmr.appendPair(clearedSender, ref("absorbed"), nonce(), NOW, clearedProof)
            expect(await storageOf(pmr).getAlarm()).toBe(live.expiresAt * 1000)
        })
    })

    it("keeps a paged expiry pass's cursor and earliest deadline when a cleared row sorts behind it", async () => {
        const stub = freshStub()
        const cleared = "did:plc:a-cleared" as const
        const live = "did:plc:b-live" as const
        await inPMR(stub, async pmr => {
            await pmr.provisionFromPool(cleared, NOW)
            await pmr.appendPair(cleared, ref("clear"), nonce(), NOW, evidence(cleared))
            await pmr.block(cleared, NOW)
            const liveProof = evidence(live)
            await pmr.appendPair(live, ref("live"), nonce(), NOW, liveProof)
            for (let i = 0; i < 105; i++) {
                const sender = `did:plc:z-expired-${String(i).padStart(3, "0")}` as const
                await pmr.appendPair(sender, ref(`old-${i}`), nonce(), NOW, evidence(sender))
            }
            const storage = storageOf(pmr)
            const proofs = await storage.list<ProofRow>({ prefix: "pairEvidence:did:plc:z" })
            for (const [key, row] of proofs) await storage.put(key, { ...row, expiresAt: NOW - 1 })
            await storage.deleteAlarm()
            await pmr.alarm()
            const cursor = await storage.get("pairEvidenceExpiryCursor")
            expect(cursor).toBeDefined()
            expect(await storage.get("pairEvidenceExpiryMin")).toBe(liveProof.expiresAt)
            await pmr.appendPair(cleared, ref("absorbed"), nonce(), NOW, evidence(cleared))
            expect(await storage.get("pairEvidenceExpiryCursor")).toBe(cursor)
            expect(await storage.get("pairEvidenceExpiryMin")).toBe(liveProof.expiresAt)
            await storage.deleteAlarm()
            await pmr.alarm()
            expect(await storage.get("pairEvidenceExpiryCursor")).toBeUndefined()
            expect(await storage.getAlarm()).toBe(liveProof.expiresAt * 1000)
            expect((await pmr.poolSenders()).map(row => row.did)).toEqual([live])
            expect((await storage.get<ProofRow>(`pairEvidence:${cleared}`))?.expiresAt).toBe(0)
        })
    })
})
