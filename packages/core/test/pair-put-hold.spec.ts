/**
 * `handlePairPut` with a sender hold wired in: a sender that just published a
 * new declaration gets `202` while the monitor catches up, and the decision
 * still reveals nothing about the recipient.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import type { PMRConfig } from "../src/config"
import { encodePairPutEnvelope } from "../src/cose/sign1"
import type { SenderDeclarationResolution } from "../src/declaration"
import { DECLARATION_RETRY_AFTER_SECONDS, handlePairPut, type PairPutDeps } from "../src/pair-put"
import type { HoldAdmission, HoldRequest } from "../src/sender-hold"
import type { MessageRef, PMRStore } from "../src/storage"

const SENDER = "did:plc:sender000000000000000000"
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC_OLD = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const DC_NEW = "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
const NOW = 1_000
const CONFIG = {
    limits: { messageMaxBytes: 10_000, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig

function keyPair() {
    const secretKey = ed25519.utils.randomSecretKey()
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

function body(secretKey: Uint8Array, recipientDID = RECIPIENT): Uint8Array {
    return encodePairPutEnvelope(
        {
            senderDID: SENDER,
            recipientDID,
            kid: new Uint8Array(32).fill(0xaa),
            nonce: new Uint8Array(16).fill(1),
            payload: new TextEncoder().encode("sealed"),
        },
        (message) => ed25519.sign(message, secretKey)
    )
}

const post = (bytes: Uint8Array) =>
    new Request("https://relay.example/pmr/v1/inbox/x/messages", { method: "POST", body: bytes })

const snapshot = (publicKey: Uint8Array, revision = "3kaaaaaaaaaaa") =>
    (): SenderDeclarationResolution => ({
        found: true,
        anchorKey: { x: publicKey },
        declarationCID: DC_OLD,
        revision,
        evidenceCAR: new Uint8Array([1]),
    })

function world(options: {
    resolution: () => SenderDeclarationResolution
    admission?: HoldAdmission | (() => HoldAdmission)
    withHold?: boolean
    budget?: (nowSeconds: number) => boolean
}) {
    const appended: Array<{ ref: MessageRef; evidence: { declarationCID: string; revision: string; car: Uint8Array } }> = []
    const bodies: string[] = []
    const lookups: string[] = []
    const holdRequests: HoldRequest[] = []
    const holdKeys: string[] = []
    const budgetSpends: number[] = []
    const store = {
        hasMailbox: async () => true,
        appendPair: async (
            _key: string,
            ref: MessageRef,
            _nonce: Uint8Array,
            _now: number,
            evidence: { declarationCID: string; revision: string; car: Uint8Array }
        ) => {
            appended.push({ ref, evidence })
            return {
                result: { outcome: "appended", persistBody: true },
                generation: "generation-1",
                evidenceCID: evidence.declarationCID,
                recycledMessageIds: [],
            }
        },
    } as unknown as PMRStore
    const deferred: Promise<unknown>[] = []
    const deps: PairPutDeps = {
        config: CONFIG,
        directory: {
            resolve: async (did: string) => {
                lookups.push(did)
                return { id: "r" } as never
            },
        } as never,
        store: () => store,
        bodies: { putBody: async (id: string) => void bodies.push(id), deleteBody: async () => {} } as never,
        resolveDeclaration: async () => options.resolution(),
        defer: (work) => void deferred.push(work),
        ...(options.withHold === false
            ? {}
            : {
                  senderHold: (key) => {
                      holdKeys.push(key)
                      return {
                          admit: async (request) => {
                              holdRequests.push(request)
                              const admission = options.admission ?? { outcome: "unverifiable" }
                              return typeof admission === "function" ? admission() : admission
                          },
                      }
                  },
              }),
        ...(options.budget
            ? {
                  unsnapshottedHoldBudget: (now: number) => {
                      budgetSpends.push(now)
                      return options.budget!(now)
                  },
              }
            : {}),
    }
    return { deps, appended, bodies, lookups, holdRequests, holdKeys, budgetSpends, settle: () => Promise.all(deferred) }
}

const noSnapshot = (): SenderDeclarationResolution => ({ found: false, reason: "no snapshot held" })

describe("pair put with a sender hold", () => {
    it("a signature failure under the snapshot consults the hold with the received envelope bytes and the snapshot revision", async () => {
        const stale = keyPair()
        const bytes = body(keyPair().secretKey)
        const w = world({ resolution: snapshot(stale.publicKey, "3kaaaaaaaaaaa") })
        await handlePairPut(post(bytes), RECIPIENT, w.deps, NOW)
        expect(w.holdKeys).toEqual([SENDER])
        expect(w.holdRequests).toHaveLength(1)
        expect(w.holdRequests[0]).toMatchObject({
            recipientDID: RECIPIENT,
            snapshotRevision: "3kaaaaaaaaaaa",
            nowSeconds: NOW,
        })
        expect(Array.from(w.holdRequests[0]!.envelope)).toEqual(Array.from(bytes))
    })

    it("with no snapshot held, the hold is consulted with a null snapshot revision once the budget allows", async () => {
        const w = world({ resolution: noSnapshot, budget: () => true })
        await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(w.budgetSpends).toEqual([NOW])
        expect(w.holdRequests).toHaveLength(1)
        expect(w.holdRequests[0]!.snapshotRevision).toBeNull()
    })

    it("with no snapshot held and the budget spent, the answer is 409 without consulting the hold", async () => {
        const w = world({ resolution: noSnapshot, budget: () => false, admission: { outcome: "accepted" } })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(409)
        expect(w.holdRequests).toEqual([])
    })

    it("with no snapshot held and no budget wired, the answer is 409 without consulting the hold", async () => {
        const w = world({ resolution: noSnapshot, admission: { outcome: "accepted" } })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(409)
        expect(w.holdRequests).toEqual([])
    })

    it("hold settled continues as a verified put under the returned declaration: stored with its CID, rev and CAR as evidence", async () => {
        const fresh = keyPair()
        const car = new Uint8Array([9, 9])
        const w = world({
            resolution: snapshot(keyPair().publicKey),
            admission: {
                outcome: "settled",
                declaration: {
                    found: true,
                    anchorKey: { x: fresh.publicKey },
                    declarationCID: DC_NEW,
                    revision: "3kccccccccccc",
                    evidenceCAR: car,
                },
            },
        })
        const response = await handlePairPut(post(body(fresh.secretKey)), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.appended).toHaveLength(1)
        expect(w.appended[0]!.ref.hint).toEqual({ senderDID: SENDER, declarationCID: DC_NEW })
        expect(w.appended[0]!.evidence).toMatchObject({
            declarationCID: DC_NEW,
            revision: "3kccccccccccc",
            car,
        })
        expect(w.bodies).toHaveLength(1)
    })

    it("hold settled with a put signed for another recipient answers 202 and stores nothing", async () => {
        const fresh = keyPair()
        const w = world({
            resolution: snapshot(keyPair().publicKey),
            admission: {
                outcome: "settled",
                declaration: {
                    found: true,
                    anchorKey: { x: fresh.publicKey },
                    declarationCID: DC_NEW,
                    revision: "3kccccccccccc",
                    evidenceCAR: new Uint8Array([1]),
                },
            },
        })
        const response = await handlePairPut(
            post(body(fresh.secretKey, "did:plc:someoneelse0000000000000")),
            RECIPIENT,
            w.deps,
            NOW
        )
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.appended).toEqual([])
        expect(w.bodies).toEqual([])
    })

    it("hold accepted answers 202 and stores nothing in any mailbox", async () => {
        const w = world({ resolution: snapshot(keyPair().publicKey), admission: { outcome: "accepted" } })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(await response.text()).toBe("")
        expect(w.appended).toEqual([])
        expect(w.bodies).toEqual([])
    })

    it("hold unverifiable answers 409 with Retry-After DECLARATION_RETRY_AFTER_SECONDS", async () => {
        const w = world({ resolution: snapshot(keyPair().publicKey), admission: { outcome: "unverifiable" } })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(409)
        expect(response.headers.get("Retry-After")).toBe(String(DECLARATION_RETRY_AFTER_SECONDS))
        expect(w.appended).toEqual([])
    })

    it("hold full answers 429 with Retry-After relative to now", async () => {
        const w = world({
            resolution: snapshot(keyPair().publicKey),
            admission: { outcome: "full", retryAfter: NOW + 240 },
        })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(429)
        expect(response.headers.get("Retry-After")).toBe("240")
    })

    it("the hold is decided before the directory is consulted: no recipient lookup on accepted, full or unverifiable", async () => {
        for (const admission of [
            { outcome: "accepted" },
            { outcome: "full", retryAfter: NOW + 5 },
            { outcome: "unverifiable" },
        ] as HoldAdmission[]) {
            const w = world({ resolution: snapshot(keyPair().publicKey), admission })
            await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
            expect(w.lookups).toEqual([])
        }
    })

    it("a put that verifies under the snapshot never consults the hold", async () => {
        const sender = keyPair()
        const w = world({ resolution: snapshot(sender.publicKey), admission: { outcome: "accepted" } })
        const response = await handlePairPut(post(body(sender.secretKey)), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.holdRequests).toEqual([])
        expect(w.appended).toHaveLength(1)
    })

    it("a malformed or oversized envelope never consults the hold", async () => {
        const w = world({ resolution: snapshot(keyPair().publicKey), admission: { outcome: "accepted" } })
        const malformed = await handlePairPut(post(new Uint8Array([1, 2, 3])), RECIPIENT, w.deps, NOW)
        expect(malformed.status).toBe(400)
        const oversized = await handlePairPut(post(new Uint8Array(20_000)), RECIPIENT, w.deps, NOW)
        expect(oversized.status).toBe(413)
        expect(w.holdRequests).toEqual([])
    })

    it("without senderHold a signature failure still answers 409", async () => {
        const w = world({ resolution: snapshot(keyPair().publicKey), withHold: false })
        const response = await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(409)
        expect(response.headers.get("Retry-After")).toBe(String(DECLARATION_RETRY_AFTER_SECONDS))
        const none = world({ resolution: noSnapshot, withHold: false, budget: () => true })
        expect((await handlePairPut(post(body(keyPair().secretKey)), RECIPIENT, none.deps, NOW)).status).toBe(409)
    })

    it("a put signed for another recipient under the snapshot key never consults the hold", async () => {
        const sender = keyPair()
        const w = world({ resolution: snapshot(sender.publicKey), admission: { outcome: "accepted" } })
        const response = await handlePairPut(
            post(body(sender.secretKey, "did:plc:someoneelse0000000000000")),
            RECIPIENT,
            w.deps,
            NOW
        )
        expect(response.status).toBe(202)
        expect(w.holdRequests).toEqual([])
    })
})
