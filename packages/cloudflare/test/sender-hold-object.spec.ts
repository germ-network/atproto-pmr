/**
 * `SenderHoldObject` and its adapters: the hold survives eviction, expires on
 * its own alarm, serializes a sender's PDS reads, and releases through the
 * same mailbox store a pair put uses.
 *
 * Harness: the `SENDER_HOLDS` binding (`TestSenderHold` in `test/worker.ts`),
 * scripted with `setDirect`; recipients registered in the directory with a
 * provisioned sender; `runInDurableObject` to read storage and
 * `runDurableObjectAlarm` to fire the alarm.
 */
import {
    env,
    evictDurableObject,
    runDurableObjectAlarm,
    runInDurableObject,
} from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    SENDER_HOLD_TTL_SECONDS,
    type HoldRequest,
    type SenderDeclarationResolution,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { releaseSenderHold, senderHolds } from "../src/sender-holds"
import {
    envelope,
    keyPair,
    resolution,
    settledDeclaration,
    REV,
} from "../../core/test/fixtures/sender-hold"
import { inPMR } from "./helpers"
import type { TestSenderHold } from "./worker"

const testEnv = env as unknown as PMREnv
const HOLDS = testEnv.SENDER_HOLDS!

let counter = 0
const freshSender = () => `did:plc:holdtest${String(++counter).padStart(14, "0")}`
const nowSeconds = () => Math.floor(Date.now() / 1000)

function holdOf(senderDID: string) {
    return HOLDS.get(HOLDS.idFromName(senderDID)) as unknown as DurableObjectStub<TestSenderHold>
}

const storageOf = <R>(senderDID: string, fn: (storage: DurableObjectStorage) => Promise<R>) =>
    runInDurableObject(holdOf(senderDID), (_object, state) => fn(state.storage))

const heldCount = (senderDID: string) =>
    storageOf(senderDID, async (storage) => (await storage.list({ prefix: "held:" })).size)

function request(
    sender: string,
    secretKey: Uint8Array,
    options: Partial<HoldRequest> & { nonce?: Uint8Array } = {}
): HoldRequest {
    return {
        recipientDID: "did:plc:recipient00000000000000000",
        envelope: envelope(secretKey, { sender, nonce: options.nonce }),
        snapshotRevision: REV.old,
        nowSeconds: nowSeconds(),
        ...options,
    }
}

async function scripted(sender: string, publicKey: Uint8Array, revision = REV.new) {
    await holdOf(sender).setDirect(resolution(publicKey, revision) as SenderDeclarationResolution)
}

afterEach(() => vi.restoreAllMocks())

describe("sender hold object", () => {
    it("a held put and the interim declaration survive the object being evicted and rebuilt", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        expect(await stub.admit(sender, request(sender, key.secretKey))).toEqual({ outcome: "accepted" })
        await evictDurableObject(stub)
        expect(await heldCount(sender)).toBe(1)
        expect(await stub.admit(sender, request(sender, key.secretKey))).toEqual({ outcome: "accepted" })
        expect(await heldCount(sender)).toBe(2)
        expect(await stub.directReads()).toBe(1)
    })

    it("holding a put arms an alarm at its expiry", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const now = nowSeconds()
        await holdOf(sender).admit(sender, request(sender, key.secretKey, { nowSeconds: now }))
        expect(await storageOf(sender, (storage) => storage.getAlarm())).toBe(
            (now + SENDER_HOLD_TTL_SECONDS) * 1000
        )
    })

    it("the alarm drops expired holds and re-arms for the earliest remaining expiry, or clears with none", async () => {
        const key = keyPair()

        const lone = freshSender()
        await scripted(lone, key.publicKey)
        await holdOf(lone).admit(
            lone,
            request(lone, key.secretKey, { nowSeconds: nowSeconds() - 2 * SENDER_HOLD_TTL_SECONDS })
        )
        await runDurableObjectAlarm(holdOf(lone))
        expect(await heldCount(lone)).toBe(0)
        expect(await storageOf(lone, (storage) => storage.getAlarm())).toBeNull()
        expect(await storageOf(lone, (storage) => storage.get("interim"))).toBeUndefined()

        const mixed = freshSender()
        await scripted(mixed, key.publicKey)
        const now = nowSeconds()
        const stub = holdOf(mixed)
        await stub.admit(mixed, request(mixed, key.secretKey, { nowSeconds: now }))
        await stub.admit(
            mixed,
            request(mixed, key.secretKey, { nowSeconds: now - SENDER_HOLD_TTL_SECONDS - 5 })
        )
        await runDurableObjectAlarm(stub)
        expect(await heldCount(mixed)).toBe(1)
        expect(await storageOf(mixed, (storage) => storage.getAlarm())).toBe(
            (now + SENDER_HOLD_TTL_SECONDS) * 1000
        )
    })

    it("two concurrent admits for one sender with no interim key read the PDS once, and both are held", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        await stub.setDelay(100)
        const outcomes = await Promise.all([
            stub.admit(sender, request(sender, key.secretKey)),
            stub.admit(sender, request(sender, key.secretKey)),
        ])
        expect(outcomes).toEqual([{ outcome: "accepted" }, { outcome: "accepted" }])
        expect(await stub.directReads()).toBe(1)
        expect(await heldCount(sender)).toBe(2)
    })

    it("a call naming a different sender DID than the object's first is refused", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        await stub.admit(sender, request(sender, key.secretKey))
        const other = freshSender()
        const refused = async (call: () => Promise<unknown>) => {
            try {
                await call()
            } catch (error) {
                return String(error)
            }
            return "not refused"
        }
        expect(await refused(() => stub.admit(other, request(other, key.secretKey)))).toMatch(
            /another sender/
        )
        expect(await refused(() => stub.settle(other, null, nowSeconds()))).toMatch(/another sender/)
        expect(await heldCount(sender)).toBe(1)
    })

    it("the default cap is MAX_MESSAGES_PER_PAIR_SENDER", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        const cap = parseInt(testEnv.MAX_MESSAGES_PER_PAIR_SENDER)
        for (let i = 0; i < cap; i++) {
            expect((await stub.admit(sender, request(sender, key.secretKey))).outcome).toBe("accepted")
        }
        const now = nowSeconds()
        const over = await stub.admit(sender, request(sender, key.secretKey, { nowSeconds: now }))
        expect(over.outcome).toBe("full")
        expect(await heldCount(sender)).toBe(cap)
    })

    it("settle releases a verifying held put into the recipient's pair mailbox and its body into the body store", async () => {
        const sender = freshSender()
        const recipient = `did:plc:recipient${String(counter).padStart(14, "0")}`
        const locator = testEnv.pmrs.newUniqueId().toString()
        await testEnv.pmrDirectory.put(recipient, locator)
        const mailbox = testEnv.pmrs.get(testEnv.pmrs.idFromString(locator)) as unknown as DurableObjectStub<PMRObject>
        await inPMR(mailbox, (pmr) => pmr.provisionFromPool(sender, nowSeconds()))

        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        const put = request(sender, key.secretKey, { recipientDID: recipient })
        put.envelope = envelope(key.secretKey, { sender, recipient, body: "hello" })
        expect(await stub.admit(sender, put)).toEqual({ outcome: "accepted" })

        const settled = settledDeclaration(key.publicKey, REV.new, { did: sender })
        const summary = await stub.settle(sender, settled, nowSeconds())
        expect(summary).toEqual({ released: 1, dropped: 0, kept: 0 })

        const refs = await inPMR(mailbox, (pmr) => pmr.list(sender, 10))
        expect(refs).toHaveLength(1)
        expect(refs[0]!.hint).toEqual({ senderDID: sender, declarationCID: settled.cid })
        const body = await testEnv.messages.get(refs[0]!.messageId, "arrayBuffer")
        expect(body).not.toBeNull()
        expect(await heldCount(sender)).toBe(0)
    })

    it("settle with null empties the hold and clears the alarm", async () => {
        const sender = freshSender()
        const key = keyPair()
        await scripted(sender, key.publicKey)
        const stub = holdOf(sender)
        await stub.admit(sender, request(sender, key.secretKey))
        expect(await storageOf(sender, (storage) => storage.getAlarm())).not.toBeNull()
        await stub.settle(sender, null, nowSeconds())
        expect(await heldCount(sender)).toBe(0)
        expect(await storageOf(sender, (storage) => storage.getAlarm())).toBeNull()
        expect(await storageOf(sender, (storage) => storage.get("interim"))).toBeUndefined()
    })

    it("a settle reaching an empty object stores it and arms the sweep, which later leaves the object empty", async () => {
        const sender = freshSender()
        const key = keyPair()
        const stub = holdOf(sender)
        const settledAt = nowSeconds() - SENDER_HOLD_TTL_SECONDS - 10
        await stub.settle(sender, settledDeclaration(key.publicKey, REV.new, { did: sender }), settledAt)
        expect(await storageOf(sender, (storage) => storage.get("settled"))).toMatchObject({
            settledAtSeconds: settledAt,
        })
        expect(await storageOf(sender, (storage) => storage.getAlarm())).toBeNull()
        const fresh = freshSender()
        const now = nowSeconds()
        await holdOf(fresh).settle(fresh, settledDeclaration(key.publicKey, REV.new, { did: fresh }), now)
        expect(await storageOf(fresh, (storage) => storage.getAlarm())).toBe(
            (now + SENDER_HOLD_TTL_SECONDS) * 1000
        )
        const lapsed = freshSender()
        await holdOf(lapsed).settle(lapsed, settledDeclaration(key.publicKey, REV.new, { did: lapsed }), settledAt)
        // Armed for an expiry already past: the sweep empties the object.
        await storageOf(lapsed, async (storage) => storage.setAlarm(Date.now() + 1000))
        await runDurableObjectAlarm(holdOf(lapsed))
        expect(await storageOf(lapsed, (storage) => storage.get("settled"))).toBeUndefined()
        expect(await storageOf(lapsed, (storage) => storage.getAlarm())).toBeNull()
    })
})

describe("sender hold adapters", () => {
    it("senderHolds is undefined when SENDER_HOLDS is not bound", () => {
        expect(senderHolds({ SENDER_HOLDS: undefined })).toBeUndefined()
        expect(senderHolds(testEnv)).toBeTypeOf("function")
    })

    it("senderHolds addresses one object per sender DID, so two senders' holds are independent", async () => {
        const a = freshSender()
        const b = freshSender()
        const key = keyPair()
        await scripted(a, key.publicKey)
        const hold = senderHolds(testEnv)!
        expect(await hold(a as never).admit(request(a, key.secretKey))).toEqual({ outcome: "accepted" })
        expect(await heldCount(a)).toBe(1)
        expect(await hold(b as never).admit(request(b, key.secretKey))).toEqual({ outcome: "unverifiable" })
        expect(await heldCount(b)).toBe(0)
        expect(await holdOf(a).directReads()).toBe(1)
        expect(await holdOf(b).directReads()).toBe(1)
    })

    it("releaseSenderHold forwards the settle to that sender's object", async () => {
        const sender = freshSender()
        const key = keyPair()
        const settled = settledDeclaration(key.publicKey, REV.new, { did: sender })
        const now = nowSeconds()
        await releaseSenderHold(testEnv, sender, settled, now)
        expect(await storageOf(sender, (storage) => storage.get("settled"))).toMatchObject({
            settledAtSeconds: now,
            declaration: { declarationCID: settled.cid, revision: REV.new },
        })
        expect(await storageOf(sender, (storage) => storage.get("sender"))).toBe(sender)
    })

    it("releaseSenderHold swallows a hold fault and does nothing when SENDER_HOLDS is not bound", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const faulty = {
            ...testEnv,
            SENDER_HOLDS: {
                idFromName: () => ({}),
                get: () => ({
                    settle: async () => {
                        throw new Error("hold down")
                    },
                }),
            } as unknown as DurableObjectNamespace,
        }
        await expect(releaseSenderHold(faulty, freshSender(), null, nowSeconds())).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalled()
        await expect(
            releaseSenderHold({ SENDER_HOLDS: undefined }, freshSender(), null, nowSeconds())
        ).resolves.toBeUndefined()
    })
})
