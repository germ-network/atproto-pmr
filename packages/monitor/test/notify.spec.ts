import { describe, expect, it, vi } from "vitest"
import { decodeCoseMap, type DeliverPushResult } from "@germ-network/atproto-pmr-core"
import { pushDeclarationChange, type DeclarationPushSender } from "../src/notify"
import type { MonitorRegistration, MonitorRegistrationStore } from "../src/registration"

const DID = "did:plc:alice"

function registration(): MonitorRegistration {
    return {
        did: DID,
        anchorKey: new Uint8Array([1, 2, 3]),
        pushSubscription: {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(4),
            keyId: 9,
        },
        registeredAt: 1_760_000_000,
    }
}

function memoryStore(seed?: MonitorRegistration): MonitorRegistrationStore & {
    rows: Map<string, MonitorRegistration>
} {
    const rows = new Map<string, MonitorRegistration>()
    if (seed !== undefined) rows.set(seed.did, seed)
    return {
        rows,
        async load(did) {
            return rows.get(did) ?? null
        },
        async put(reg) {
            rows.set(reg.did, reg)
        },
        async delete(did) {
            rows.delete(did)
        },
    }
}

function stubSender(result: DeliverPushResult): DeclarationPushSender & {
    calls: { subscription: MonitorRegistration["pushSubscription"]; plaintext: Uint8Array }[]
} {
    const calls: { subscription: MonitorRegistration["pushSubscription"]; plaintext: Uint8Array }[] = []
    return {
        calls,
        async send(subscription, plaintext) {
            calls.push({ subscription, plaintext })
            return result
        },
    }
}

describe("pushDeclarationChange", () => {
    it("sends exactly {t:\"d\"} and nothing else", async () => {
        const store = memoryStore(registration())
        const sender = stubSender({ outcome: "delivered" })

        await pushDeclarationChange(DID, { registrations: store, sender })

        expect(sender.calls).toHaveLength(1)
        const map = decodeCoseMap(sender.calls[0].plaintext)
        expect(map.size).toBe(1)
        expect(map.get("t")).toBe("d")
    })

    it("no registration for the DID: no send at all, returns null", async () => {
        const store = memoryStore()
        const sender = stubSender({ outcome: "delivered" })

        const result = await pushDeclarationChange(DID, { registrations: store, sender })

        expect(sender.calls).toHaveLength(0)
        expect(result).toBeNull()
    })

    it("a discard outcome deletes the registration", async () => {
        const store = memoryStore(registration())
        const sender = stubSender({ outcome: "discard" })

        await pushDeclarationChange(DID, { registrations: store, sender })

        expect(store.rows.has(DID)).toBe(false)
    })

    it("delivered does not delete the registration", async () => {
        const store = memoryStore(registration())
        const sender = stubSender({ outcome: "delivered" })

        await pushDeclarationChange(DID, { registrations: store, sender })

        expect(store.rows.has(DID)).toBe(true)
    })

    it("retry does not delete the registration", async () => {
        const store = memoryStore(registration())
        const sender = stubSender({ outcome: "retry", retryAfterSeconds: 30 })

        await pushDeclarationChange(DID, { registrations: store, sender })

        expect(store.rows.has(DID)).toBe(true)
    })

    it("failed does not delete the registration, and the outcome is returned for the caller to log", async () => {
        // This module stays console-free by design (see the module doc
        // comment) — logging a `"failed"` outcome is the deployment
        // adapter's job, which it can only do if the outcome actually
        // comes back rather than being swallowed into `void`.
        const store = memoryStore(registration())
        const sender = stubSender({ outcome: "failed", status: 401 })

        const result = await pushDeclarationChange(DID, { registrations: store, sender })

        expect(store.rows.has(DID)).toBe(true)
        expect(result).toEqual({ outcome: "failed", status: 401 })
    })

    it("propagates a thrown send error — this module does not swallow it", async () => {
        const store = memoryStore(registration())
        const sender: DeclarationPushSender = {
            send: vi.fn(async () => {
                throw new Error("network down")
            }),
        }

        await expect(
            pushDeclarationChange(DID, { registrations: store, sender })
        ).rejects.toThrow("network down")
    })
})
