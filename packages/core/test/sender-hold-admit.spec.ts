/**
 * `admitToHold`: a put that failed under the monitor's snapshot is delivered
 * under a declaration the monitor has already settled, or held exactly when
 * it verifies under a declaration the sender's PDS shows newer than both the
 * snapshot and the last settle; the PDS is read at most once per memo window.
 *
 * Harness: an in-memory `SenderHoldStorage`; `readDirect` a counting fake
 * scripted per test, coalescing concurrent calls as the contract requires;
 * envelopes from `encodePairPutEnvelope` signed with an old key A (the
 * snapshot's) and a new key B (the PDS's). Revisions are TIDs.
 */
import { describe, expect, it, vi } from "vitest"
import type { SenderDeclarationResolution } from "../src/declaration"
import {
    DIRECT_READ_MEMO_SECONDS,
    SENDER_HOLD_TTL_SECONDS,
    admitToHold,
    perMinuteBudget,
    type HoldRequest,
} from "../src/sender-hold"
import {
    REV,
    SENDER,
    SENDER_KEY,
    envelope,
    heldPut,
    keyPair,
    memoryStorage,
    nextNonce,
    nonceHexOf,
    resolution,
    storedSettled,
} from "./fixtures/sender-hold"

const NOW = 10_000

function setup(
    options: {
        direct?: SenderDeclarationResolution | (() => Promise<SenderDeclarationResolution>)
        maxHeld?: number
        storage?: Parameters<typeof memoryStorage>[0]
    } = {}
) {
    const keyA = keyPair()
    const keyB = keyPair()
    const storage = memoryStorage(options.storage)
    let inFlight: Promise<SenderDeclarationResolution> | null = null
    const direct = options.direct ?? resolution(keyB.publicKey, REV.new)
    const readDirect = vi.fn((): Promise<SenderDeclarationResolution> => {
        inFlight ??= (async () => {
            try {
                return typeof direct === "function" ? await direct() : direct
            } finally {
                inFlight = null
            }
        })()
        return inFlight
    })
    const admit = (
        secretKey: Uint8Array,
        request: Partial<Omit<HoldRequest, "envelope">> & { envelope?: Uint8Array } = {}
    ) =>
        admitToHold(
            {
                recipientDID: "did:plc:recipient00000000000000000",
                envelope: request.envelope ?? envelope(secretKey),
                snapshotRevision: REV.old,
                nowSeconds: NOW,
                ...request,
            },
            { senderDID: SENDER_KEY, storage, readDirect, maxHeld: options.maxHeld ?? 5 }
        )
    return { keyA, keyB, storage, readDirect, admit }
}

describe("verifying a put the snapshot could not", () => {
    it("a put that verifies under a stored settled declaration newer than the snapshot answers settled with that declaration, without a PDS read", async () => {
        const t = setup()
        t.storage.state.settled = storedSettled(t.keyB.publicKey, REV.new, NOW - 5)
        const out = await t.admit(t.keyB.secretKey)
        expect(out).toEqual({
            outcome: "settled",
            declaration: t.storage.state.settled.declaration,
        })
        expect(t.readDirect).not.toHaveBeenCalled()
        expect(t.storage.state.held).toEqual([])
    })

    it("a stored settled declaration no newer than the snapshot revision is not used", async () => {
        const t = setup({ direct: { found: false, reason: "n/a" } })
        t.storage.state.settled = storedSettled(t.keyB.publicKey, REV.new, NOW - 5)
        for (const snapshotRevision of [REV.new, REV.newer]) {
            const out = await t.admit(t.keyB.secretKey, { snapshotRevision })
            expect(out).toEqual({ outcome: "unverifiable" })
        }
    })

    it("after a settle reached an empty hold, a put failing under an older snapshot answers settled and is not held", async () => {
        const t = setup()
        t.storage.state.settled = storedSettled(t.keyB.publicKey, REV.mid, NOW - 30)
        const out = await t.admit(t.keyB.secretKey, { snapshotRevision: REV.old })
        expect(out.outcome).toBe("settled")
        expect(t.storage.state.held).toEqual([])
        expect(t.storage.state.interim).toBeNull()
    })

    it("a put signed by the PDS-declared key, newer than the snapshot, is held and accepted", async () => {
        const t = setup()
        const bytes = envelope(t.keyB.secretKey)
        expect(await t.admit(t.keyB.secretKey, { envelope: bytes })).toEqual({ outcome: "accepted" })
        expect(t.readDirect).toHaveBeenCalledTimes(1)
        expect(t.storage.state.held).toHaveLength(1)
        expect(t.storage.state.held[0]).toMatchObject({
            envelope: bytes,
            nonceHex: nonceHexOf(bytes),
        })
    })

    it("a put verified by a fresh read caches that declaration as the interim key", async () => {
        const t = setup()
        await t.admit(t.keyB.secretKey)
        expect(t.storage.state.interim).toEqual({
            anchorKey: t.keyB.publicKey,
            declarationCID: `cid-${REV.new}`,
            revision: REV.new,
            readAtSeconds: NOW,
        })
        expect(t.storage.state.lastDirectReadAt).toBe(NOW)
    })

    it("a later put verified by the cached interim key is held without another PDS read", async () => {
        const t = setup()
        await t.admit(t.keyB.secretKey)
        expect(await t.admit(t.keyB.secretKey, { nowSeconds: NOW + 5 })).toEqual({
            outcome: "accepted",
        })
        expect(t.readDirect).toHaveBeenCalledTimes(1)
        expect(t.storage.state.held).toHaveLength(2)
    })

    it("a put that fails under the interim key reads the PDS again only after DIRECT_READ_MEMO_SECONDS from the last completed read", async () => {
        const t = setup()
        await t.admit(t.keyB.secretKey)
        const stranger = keyPair()
        await t.admit(stranger.secretKey, { nowSeconds: NOW + DIRECT_READ_MEMO_SECONDS - 1 })
        expect(t.readDirect).toHaveBeenCalledTimes(1)
        await t.admit(stranger.secretKey, { nowSeconds: NOW + DIRECT_READ_MEMO_SECONDS })
        expect(t.readDirect).toHaveBeenCalledTimes(2)
    })

    it("inside the memo window a put no interim key verifies is unverifiable without a PDS read", async () => {
        const t = setup({ storage: { lastDirectReadAt: NOW - 10 } })
        const out = await t.admit(keyPair().secretKey)
        expect(out).toEqual({ outcome: "unverifiable" })
        expect(t.readDirect).not.toHaveBeenCalled()
    })

    it("a put issued while another's read is in flight shares that read, and both are held", async () => {
        let release!: (value: SenderDeclarationResolution) => void
        const t = setup({
            direct: () =>
                new Promise<SenderDeclarationResolution>((resolve) => {
                    release = resolve
                }),
        })
        const first = t.admit(t.keyB.secretKey)
        const second = t.admit(t.keyB.secretKey)
        await vi.waitFor(() => expect(t.readDirect).toHaveBeenCalledTimes(2))
        release(resolution(t.keyB.publicKey, REV.new))
        expect(await Promise.all([first, second])).toEqual([
            { outcome: "accepted" },
            { outcome: "accepted" },
        ])
        expect(t.storage.state.held).toHaveLength(2)
    })

    it("a PDS declaration no newer than the snapshot revision is unverifiable and not cached", async () => {
        const t = setup()
        for (const snapshotRevision of [REV.new, REV.newer]) {
            const out = await t.admit(t.keyB.secretKey, { snapshotRevision })
            expect(out).toEqual({ outcome: "unverifiable" })
        }
        expect(t.storage.state.interim).toBeNull()
        expect(t.storage.state.held).toEqual([])
    })

    it("a PDS declaration no newer than the stored settled revision is unverifiable and not cached", async () => {
        const t = setup()
        t.storage.state.settled = storedSettled(keyPair().publicKey, REV.new, NOW - 5)
        const out = await t.admit(t.keyB.secretKey)
        expect(out).toEqual({ outcome: "unverifiable" })
        expect(t.storage.state.interim).toBeNull()
        expect(t.storage.state.held).toEqual([])
    })

    it("with no snapshot held, a verified PDS declaration admits the put", async () => {
        const t = setup()
        const out = await t.admit(t.keyB.secretKey, { snapshotRevision: null })
        expect(out).toEqual({ outcome: "accepted" })
        expect(t.storage.state.held).toHaveLength(1)
    })

    it("a put that fails under the PDS-declared key is unverifiable, and that newer declaration is still cached", async () => {
        const t = setup()
        const out = await t.admit(t.keyA.secretKey)
        expect(out).toEqual({ outcome: "unverifiable" })
        expect(t.storage.state.interim).toMatchObject({ revision: REV.new })
        expect(t.storage.state.held).toEqual([])
    })

    it("a PDS read that is found: false is unverifiable", async () => {
        const t = setup({ direct: { found: false, reason: "pds down" } })
        expect(await t.admit(t.keyB.secretKey)).toEqual({ outcome: "unverifiable" })
        expect(t.storage.state.interim).toBeNull()
        expect(t.storage.state.lastDirectReadAt).toBe(NOW)
    })

    it("an interim key older than SENDER_HOLD_TTL_SECONDS is not used", async () => {
        const t = setup({ direct: { found: false, reason: "pds down" } })
        t.storage.state.interim = {
            anchorKey: t.keyB.publicKey,
            declarationCID: "cid",
            revision: REV.new,
            readAtSeconds: NOW - SENDER_HOLD_TTL_SECONDS,
        }
        expect(await t.admit(t.keyB.secretKey)).toEqual({ outcome: "unverifiable" })
        expect(t.storage.state.held).toEqual([])
    })

    it("a put signed for another recipient under the interim key is accepted and not held", async () => {
        const t = setup()
        const bytes = envelope(t.keyB.secretKey, { recipient: "did:plc:someoneelse0000000000000" })
        expect(await t.admit(t.keyB.secretKey, { envelope: bytes })).toEqual({ outcome: "accepted" })
        expect(t.storage.state.held).toEqual([])
    })

    it("a put naming another sender than the hold's is unverifiable without a read", async () => {
        const t = setup()
        const bytes = envelope(t.keyB.secretKey, { sender: "did:plc:other00000000000000000000" })
        expect(await t.admit(t.keyB.secretKey, { envelope: bytes })).toEqual({ outcome: "unverifiable" })
        expect(t.readDirect).not.toHaveBeenCalled()
    })

    it("an undecodable envelope is unverifiable without a read", async () => {
        const t = setup()
        expect(
            await t.admit(t.keyB.secretKey, { envelope: new Uint8Array([1, 2, 3]) })
        ).toEqual({ outcome: "unverifiable" })
        expect(t.readDirect).not.toHaveBeenCalled()
    })

    it("an interim key no newer than the snapshot is not used", async () => {
        const t = setup({ direct: { found: false, reason: "pds down" } })
        t.storage.state.interim = {
            anchorKey: t.keyB.publicKey,
            declarationCID: "cid",
            revision: REV.mid,
            readAtSeconds: NOW - 5,
        }
        expect(await t.admit(t.keyB.secretKey, { snapshotRevision: REV.mid })).toEqual({
            outcome: "unverifiable",
        })
        expect(t.storage.state.held).toEqual([])
    })

    it("a settle that lands during the read is honoured: the put answers settled rather than waiting", async () => {
        let release!: (value: SenderDeclarationResolution) => void
        const t = setup({
            direct: () =>
                new Promise<SenderDeclarationResolution>((resolve) => {
                    release = resolve
                }),
        })
        const pending = t.admit(t.keyB.secretKey)
        await vi.waitFor(() => expect(t.readDirect).toHaveBeenCalled())
        t.storage.state.settled = storedSettled(t.keyB.publicKey, REV.new, NOW)
        release(resolution(t.keyB.publicKey, REV.new))
        expect((await pending).outcome).toBe("settled")
        expect(t.storage.state.held).toEqual([])
    })
})

describe("holding a verified put", () => {
    it("a repeat of a held nonce is accepted and held once, even when the hold is full", async () => {
        const t = setup({ maxHeld: 1 })
        const bytes = envelope(t.keyB.secretKey)
        await t.admit(t.keyB.secretKey, { envelope: bytes })
        expect(await t.admit(t.keyB.secretKey, { envelope: bytes })).toEqual({ outcome: "accepted" })
        expect(t.storage.state.held).toHaveLength(1)
    })

    it("at maxHeld held puts the next verified put is full, retryAfter the earliest held expiry", async () => {
        const t = setup({ maxHeld: 2 })
        await t.admit(t.keyB.secretKey, { nowSeconds: NOW })
        await t.admit(t.keyB.secretKey, { nowSeconds: NOW + 5 })
        const out = await t.admit(t.keyB.secretKey, { nowSeconds: NOW + 10 })
        expect(out).toEqual({ outcome: "full", retryAfter: NOW + SENDER_HOLD_TTL_SECONDS })
        expect(t.storage.state.held).toHaveLength(2)
    })

    it("two puts verified by one coalesced read cannot together exceed maxHeld: the cap is checked after the read resolves", async () => {
        let release!: (value: SenderDeclarationResolution) => void
        const t = setup({
            maxHeld: 1,
            direct: () =>
                new Promise<SenderDeclarationResolution>((resolve) => {
                    release = resolve
                }),
        })
        const first = t.admit(t.keyB.secretKey)
        const second = t.admit(t.keyB.secretKey)
        await vi.waitFor(() => expect(t.readDirect).toHaveBeenCalledTimes(2))
        release(resolution(t.keyB.publicKey, REV.new))
        const outcomes = (await Promise.all([first, second])).map((out) => out.outcome).sort()
        expect(outcomes).toEqual(["accepted", "full"])
        expect(t.storage.state.held).toHaveLength(1)
    })

    it("an unverifiable put against a full hold is unverifiable, not full", async () => {
        const t = setup({ maxHeld: 1 })
        await t.admit(t.keyB.secretKey)
        const out = await t.admit(keyPair().secretKey, { nowSeconds: NOW + 1 })
        expect(out).toEqual({ outcome: "unverifiable" })
    })

    it("a held put expires SENDER_HOLD_TTL_SECONDS after it was held and records the revision it verified under", async () => {
        const t = setup()
        await t.admit(t.keyB.secretKey)
        expect(t.storage.state.held[0]).toMatchObject({
            heldUnderRevision: REV.new,
            heldAtSeconds: NOW,
            expiresAtSeconds: NOW + SENDER_HOLD_TTL_SECONDS,
            recipientDID: "did:plc:recipient00000000000000000",
        })
    })

    it("a nonce held for one recipient is absorbed when repeated for another", async () => {
        const t = setup()
        const nonce = nextNonce()
        await t.admit(t.keyB.secretKey, {
            envelope: envelope(t.keyB.secretKey, { nonce }),
        })
        await t.admit(t.keyB.secretKey, {
            recipientDID: "did:plc:second0000000000000000000",
            envelope: envelope(t.keyB.secretKey, { nonce, recipient: "did:plc:second0000000000000000000" }),
        })
        expect(t.storage.state.held).toHaveLength(1)
    })

    it("a put held while other puts are held keeps arrival order", async () => {
        const t = setup()
        t.storage.state.held = [heldPut(t.keyB.secretKey, { heldAt: NOW - 20 })]
        await t.admit(t.keyB.secretKey)
        expect(t.storage.state.held.map((put) => put.heldAtSeconds)).toEqual([NOW - 20, NOW])
    })
})

describe("per-minute budget", () => {
    it("perMinuteBudget allows that many spends in a minute, refuses the next, and refills the next minute", () => {
        const spend = perMinuteBudget(2)
        expect([spend(600), spend(610), spend(659)]).toEqual([true, true, false])
        expect(spend(660)).toBe(true)
        expect(spend(661)).toBe(true)
        expect(spend(662)).toBe(false)
    })
})
