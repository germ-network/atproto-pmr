/**
 * `releaseHeld` and `sweepExpiredHolds`: what reaches a mailbox is decided by
 * the monitor's settled declaration alone. A held put is delivered only if
 * it verifies under the settled key, with the settled declaration as its
 * evidence; the interim key from the PDS never delivers anything.
 *
 * Harness: an in-memory `SenderHoldStorage` pre-loaded with held puts; a
 * settled declaration built as a signed CAR; `AuthenticatedPutDeps` over a
 * fake store recording each ingest's put and evidence.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PMRConfig } from "../src/config"
import {
    SENDER_HOLD_TTL_SECONDS,
    admitToHold,
    releaseHeld,
    sweepExpiredHolds,
    type ReleaseDeps,
} from "../src/sender-hold"
import type { MessageRef, PMRStore } from "../src/storage"
import {
    RECIPIENT,
    REV,
    SENDER,
    SENDER_KEY,
    envelope,
    heldPut,
    keyPair,
    memoryStorage,
    resolution,
    settledDeclaration,
    storedSettled,
} from "./fixtures/sender-hold"

const NOW = 10_000
const CONFIG = {
    limits: { messageMaxBytes: 10_000, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig

interface Ingest {
    recipient: string
    key: string
    ref: MessageRef
    nonce: Uint8Array
    evidence: {
        anchorKey: Uint8Array
        declarationCID: string
        revision: string
        car: Uint8Array
        expiresAt: number
    }
}

function setup(
    options: {
        held?: Parameters<typeof heldPut>[1][]
        secretKey?: Uint8Array
        storage?: Parameters<typeof memoryStorage>[0]
        unknownRecipients?: string[]
        refuseRecipients?: string[]
        putBody?: (id: string) => Promise<void>
    } = {}
) {
    const key = keyPair()
    const storage = memoryStorage(options.storage)
    for (const spec of options.held ?? []) storage.state.held.push(heldPut(options.secretKey ?? key.secretKey, { heldAt: NOW - 10, ...spec }))
    const ingests: Ingest[] = []
    const order: string[] = []
    const seenNonces = new Set<string>()
    const bodies: string[] = []
    const stores = (locator: string) =>
        ({
            appendPair: async (
                mailbox: string,
                ref: MessageRef,
                nonce: Uint8Array,
                _now: number,
                evidence: Ingest["evidence"]
            ) => {
                const seen = Array.from(nonce).join(",")
                if (options.refuseRecipients?.includes(locator)) {
                    return {
                        result: { outcome: "refused", retryAfter: NOW + 5 },
                        generation: "g",
                        evidenceCID: evidence.declarationCID,
                        recycledMessageIds: [],
                    }
                }
                if (seenNonces.has(`${locator}/${seen}`)) {
                    return {
                        result: { outcome: "appended", persistBody: false },
                        generation: "g",
                        evidenceCID: evidence.declarationCID,
                        recycledMessageIds: [],
                    }
                }
                seenNonces.add(`${locator}/${seen}`)
                ingests.push({ recipient: locator, key: mailbox, ref, nonce, evidence })
                order.push(locator)
                return {
                    result: { outcome: "appended", persistBody: true },
                    generation: "g",
                    evidenceCID: evidence.declarationCID,
                    recycledMessageIds: [],
                }
            },
            deliverLive: async () => {},
            deliverPush: async () => {},
        }) as unknown as PMRStore
    const deps: ReleaseDeps = {
        senderDID: SENDER_KEY,
        storage,
        config: CONFIG,
        directory: {
            resolve: async (did: string) => (options.unknownRecipients?.includes(did) ? null : did),
        } as never,
        store: (locator) => stores(locator as unknown as string),
        bodies: {
            putBody: async (id: string) => {
                await options.putBody?.(id)
                bodies.push(id)
            },
            deleteBody: async () => {},
        } as never,
        defer: () => {},
    }
    const release = (settled: Parameters<typeof releaseHeld>[0], now = NOW) =>
        releaseHeld(settled, deps, now)
    return { key, storage, ingests, bodies, order, deps, release, seenNonces }
}

afterEach(() => vi.restoreAllMocks())

const t0Key = () => keyPair().publicKey

describe("releasing held puts on a monitor settle", () => {
    it("a held put that verifies under the settled key is ingested with the settled CID, rev, CAR and anchor key as evidence", async () => {
        const t = setup({
            held: [{ heldUnder: REV.mid }],
            storage: {
                interim: {
                    anchorKey: t0Key(),
                    declarationCID: "cid-interim",
                    revision: REV.mid,
                    readAtSeconds: NOW - 5,
                },
            },
        })
        const settled = settledDeclaration(t.key.publicKey, REV.new)
        const summary = await t.release(settled)
        expect(summary).toEqual({ released: 1, dropped: 0, kept: 0 })
        expect(t.ingests).toHaveLength(1)
        expect(t.ingests[0]!.key).toBe(SENDER)
        expect(t.ingests[0]!.ref.hint).toEqual({ senderDID: SENDER, declarationCID: settled.cid })
        expect(t.ingests[0]!.evidence).toMatchObject({
            declarationCID: settled.cid,
            revision: REV.new,
            car: settled.car,
        })
        expect(Array.from(t.ingests[0]!.evidence.anchorKey)).toEqual(Array.from(t.key.publicKey))
        expect(t.storage.state.held).toEqual([])
        expect(t.bodies).toHaveLength(1)
    })

    it("released puts are ingested in arrival order and removed from the hold", async () => {
        const t = setup({
            held: [
                { recipient: "did:plc:first00000000000000000000", heldAt: NOW - 30 },
                { recipient: "did:plc:second0000000000000000000", heldAt: NOW - 20 },
                { recipient: "did:plc:third00000000000000000000", heldAt: NOW - 10 },
            ],
        })
        await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(t.order).toEqual([
            "did:plc:first00000000000000000000",
            "did:plc:second0000000000000000000",
            "did:plc:third00000000000000000000",
        ])
        expect(t.storage.state.held).toEqual([])
    })

    it("the envelope nonce is the replay key, so a put the sender also retried after settle is stored once", async () => {
        const t = setup({ held: [{}] })
        const held = t.storage.state.held[0]!
        const settled = settledDeclaration(t.key.publicKey, REV.new)
        await t.release(settled)
        t.storage.state.held = [held]
        const second = await t.release(settled)
        expect(t.ingests).toHaveLength(1)
        expect(second.released).toBe(1)
        expect(t.seenNonces.size).toBe(1)
    })

    it("released evidence expires messageExpirySeconds after the release", async () => {
        const t = setup({ held: [{}] })
        await t.release(settledDeclaration(t.key.publicKey, REV.new), NOW)
        expect(t.ingests[0]!.evidence.expiresAt).toBe(NOW + 1000)
    })

    it("a held put that fails under a settled revision at least as new as the one it was held under is dropped", async () => {
        const stranger = keyPair()
        for (const heldUnder of [REV.new, REV.mid]) {
            const t = setup({ held: [{ heldUnder }], secretKey: stranger.secretKey })
            const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
            expect(summary).toEqual({ released: 0, dropped: 1, kept: 0 })
            expect(t.ingests).toEqual([])
            expect(t.storage.state.held).toEqual([])
        }
    })

    it("a settle of an older revision than a put was held under keeps that put waiting", async () => {
        const t = setup({ held: [{ heldUnder: REV.newer }], secretKey: keyPair().secretKey })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 0, dropped: 0, kept: 1 })
        expect(t.storage.state.held).toHaveLength(1)
    })

    it("a settled revision at least the interim's clears the interim declaration", async () => {
        const interim = (revision: string) => ({
            anchorKey: keyPair().publicKey,
            declarationCID: "cid",
            revision,
            readAtSeconds: NOW - 5,
        })
        for (const [interimRev, cleared] of [
            [REV.new, true],
            [REV.mid, true],
            [REV.newer, false],
        ] as const) {
            const t = setup({ storage: { interim: interim(interimRev) } })
            await t.release(settledDeclaration(t.key.publicKey, REV.new))
            expect(t.storage.state.interim === null).toBe(cleared)
        }
    })

    it("a held put signed for a recipient with no registration is dropped at release", async () => {
        const t = setup({
            held: [{ recipient: "did:plc:unknown000000000000000000" }, {}],
            unknownRecipients: ["did:plc:unknown000000000000000000"],
        })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 1, dropped: 1, kept: 0 })
        expect(t.storage.state.held).toEqual([])
    })

    it("an ingest refused for a full reservation drops the held put", async () => {
        const t = setup({ held: [{}], refuseRecipients: [RECIPIENT] })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 0, dropped: 1, kept: 0 })
        expect(t.storage.state.held).toEqual([])
    })

    it("a settle with null drops every held put and the interim declaration", async () => {
        const t = setup({
            held: [{}, {}],
            storage: {
                interim: {
                    anchorKey: keyPair().publicKey,
                    declarationCID: "cid",
                    revision: REV.new,
                    readAtSeconds: NOW,
                },
            },
        })
        const summary = await t.release(null)
        expect(summary).toEqual({ released: 0, dropped: 2, kept: 0 })
        expect(t.storage.state.held).toEqual([])
        expect(t.storage.state.interim).toBeNull()
        expect(t.ingests).toEqual([])
    })

    it("a settled CAR with no readable anchor key releases nothing and drops puts held under an older or equal revision", async () => {
        const t = setup({
            held: [{ heldUnder: REV.mid }, { heldUnder: REV.new }, { heldUnder: REV.newer }],
        })
        const broken = await brokenKeySettle(REV.new)
        const summary = await t.release(broken)
        expect(summary).toEqual({ released: 0, dropped: 2, kept: 1 })
        expect(t.ingests).toEqual([])
        expect(t.storage.state.held.map((put) => put.heldUnderRevision)).toEqual([REV.newer])
        expect(t.storage.state.settled).toBeNull()
    })

    it("a settled CAR whose commit names another DID, whose rev is not settled.rev, or whose record CID is not settled.cid releases and stores nothing", async () => {
        const t = setup({ held: [{}] })
        const good = settledDeclaration(t.key.publicKey, REV.new)
        const forged = [
            settledDeclaration(t.key.publicKey, REV.new, { did: "did:plc:other00000000000000000000" }),
            settledDeclaration(t.key.publicKey, REV.new, { carRev: REV.mid }),
            { ...good, cid: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" },
            { ...good, car: new Uint8Array([1, 2, 3]) },
        ]
        for (const settled of forged) {
            const summary = await t.release(settled)
            expect(summary).toEqual({ released: 0, dropped: 0, kept: 1 })
        }
        expect(t.ingests).toEqual([])
        expect(t.storage.state.held).toHaveLength(1)
        expect(t.storage.state.settled).toBeNull()
    })

    it("a settle older than the stored settled revision releases and stores nothing", async () => {
        const stored = storedSettled(keyPair().publicKey, REV.newer, NOW - 5)
        const t = setup({ held: [{}], storage: { settled: stored } })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 0, dropped: 0, kept: 1 })
        expect(t.ingests).toEqual([])
        expect(t.storage.state.settled).toBe(stored)
    })

    it("a repeated settle of the same declaration after release changes nothing", async () => {
        const t = setup({ held: [{}] })
        const settled = settledDeclaration(t.key.publicKey, REV.new)
        await t.release(settled, NOW)
        const after = structuredClone(t.storage.state)
        const again = await t.release(settled, NOW + 3)
        expect(again).toEqual({ released: 0, dropped: 0, kept: 0 })
        expect(t.ingests).toHaveLength(1)
        expect(t.storage.state.held).toEqual(after.held)
        expect(t.storage.state.interim).toEqual(after.interim)
        expect(t.storage.state.settled?.declaration).toEqual(after.settled?.declaration)
    })

    it("a settle reaching an empty hold still stores the settled declaration", async () => {
        const t = setup()
        const settled = settledDeclaration(t.key.publicKey, REV.new)
        expect(await t.release(settled)).toEqual({ released: 0, dropped: 0, kept: 0 })
        expect(t.storage.state.settled).toMatchObject({
            settledAtSeconds: NOW,
            declaration: {
                found: true,
                declarationCID: settled.cid,
                revision: REV.new,
                evidenceCAR: settled.car,
            },
        })
        expect(Array.from(t.storage.state.settled!.declaration.anchorKey.x)).toEqual(
            Array.from(t.key.publicKey)
        )
    })

    it("a settle with null clears the stored settled declaration", async () => {
        const t = setup({ storage: { settled: storedSettled(keyPair().publicKey, REV.new, NOW - 5) } })
        await t.release(null)
        expect(t.storage.state.settled).toBeNull()
    })

    it("after a null, a put verified by a direct read is held and released by the later re-interest settle", async () => {
        const t = setup()
        await t.release(null)
        const readDirect = vi.fn(async () => resolution(t.key.publicKey, REV.new))
        const admission = await admitToHold(
            {
                recipientDID: RECIPIENT,
                envelope: envelope(t.key.secretKey),
                snapshotRevision: null,
                nowSeconds: NOW,
            },
            { senderDID: SENDER_KEY, storage: t.storage, readDirect, maxHeld: 5 }
        )
        expect(admission).toEqual({ outcome: "accepted" })
        expect(t.storage.state.held).toHaveLength(1)
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new), NOW + 30)
        expect(summary).toEqual({ released: 1, dropped: 0, kept: 0 })
        expect(t.ingests).toHaveLength(1)
    })

    it("release returns only after every deferred body write and delivery has settled", async () => {
        let finished = 0
        const t = setup({
            held: [{}, {}],
            putBody: async () => {
                await new Promise((resolve) => setTimeout(resolve, 15))
                finished += 1
            },
        })
        await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(finished).toBe(2)
        expect(t.bodies).toHaveLength(2)
    })

    it("a deferred task that rejects is logged, and the release still removes every processed put", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        const t = setup({
            held: [{}, {}],
            putBody: async () => {
                throw new Error("body store down")
            },
        })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary.released).toBe(2)
        expect(t.storage.state.held).toEqual([])
        expect(logged).toHaveBeenCalled()
    })

    it("a held put whose ingest throws stays held for the next settle", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        const t = setup({ held: [{}] })
        t.deps.directory.resolve = async () => {
            throw new Error("directory down")
        }
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 0, dropped: 0, kept: 1 })
        expect(t.storage.state.held).toHaveLength(1)
        expect(logged).toHaveBeenCalled()
    })
})

async function brokenKeySettle(revision: string) {
    const { buildRepoCar } = await import("./fixtures/repo-car")
    const { DECL_PATH } = await import("./fixtures/sender-hold")
    const repo = buildRepoCar({
        did: SENDER,
        rev: revision,
        records: { [DECL_PATH]: { $type: "com.germnetwork.declaration", version: "1.2.0", currentKey: "text" } },
    })
    return { rev: revision, cid: repo.recordCids[DECL_PATH]!, car: repo.car }
}

describe("expiring held puts", () => {
    it("a sweep drops held puts past their expiry and keeps the rest", async () => {
        const t = setup({
            held: [{ heldAt: NOW - 700, expiresAt: NOW - 100 }, { heldAt: NOW - 700, expiresAt: NOW }, { heldAt: NOW, expiresAt: NOW + 600 }],
        })
        await sweepExpiredHolds(t.storage, NOW)
        expect(t.storage.state.held.map((put) => put.expiresAtSeconds)).toEqual([NOW + 600])
    })

    it("a sweep drops an interim declaration older than SENDER_HOLD_TTL_SECONDS", async () => {
        const interim = (readAtSeconds: number) => ({
            anchorKey: keyPair().publicKey,
            declarationCID: "cid",
            revision: REV.new,
            readAtSeconds,
        })
        const expired = setup({ storage: { interim: interim(NOW - SENDER_HOLD_TTL_SECONDS) } })
        await sweepExpiredHolds(expired.storage, NOW)
        expect(expired.storage.state.interim).toBeNull()
        const fresh = setup({ storage: { interim: interim(NOW - SENDER_HOLD_TTL_SECONDS + 1) } })
        await sweepExpiredHolds(fresh.storage, NOW)
        expect(fresh.storage.state.interim).not.toBeNull()
    })

    it("a sweep drops a stored settled declaration older than SENDER_HOLD_TTL_SECONDS", async () => {
        const key = keyPair().publicKey
        const expired = setup({ storage: { settled: storedSettled(key, REV.new, NOW - SENDER_HOLD_TTL_SECONDS) } })
        await sweepExpiredHolds(expired.storage, NOW)
        expect(expired.storage.state.settled).toBeNull()
        const fresh = setup({ storage: { settled: storedSettled(key, REV.new, NOW - SENDER_HOLD_TTL_SECONDS + 1) } })
        await sweepExpiredHolds(fresh.storage, NOW)
        expect(fresh.storage.state.settled).not.toBeNull()
    })

    it("a sweep returns the earliest remaining expiry, or null when nothing is held", async () => {
        const empty = setup()
        expect(await sweepExpiredHolds(empty.storage, NOW)).toBeNull()
        const t = setup({
            held: [{ expiresAt: NOW + 300 }, { expiresAt: NOW + 100 }],
            storage: { settled: storedSettled(keyPair().publicKey, REV.new, NOW - 10) },
        })
        expect(await sweepExpiredHolds(t.storage, NOW)).toBe(NOW + 100)
        const settledOnly = setup({ storage: { settled: storedSettled(keyPair().publicKey, REV.new, NOW - 10) } })
        expect(await sweepExpiredHolds(settledOnly.storage, NOW)).toBe(NOW - 10 + SENDER_HOLD_TTL_SECONDS)
    })

    it("a release drops expired held puts without ingesting them", async () => {
        const t = setup({ held: [{ heldAt: NOW - 700, expiresAt: NOW - 100 }, { heldAt: NOW - 10, expiresAt: NOW + 590 }] })
        const summary = await t.release(settledDeclaration(t.key.publicKey, REV.new))
        expect(summary).toEqual({ released: 1, dropped: 1, kept: 0 })
        expect(t.ingests).toHaveLength(1)
    })
})
