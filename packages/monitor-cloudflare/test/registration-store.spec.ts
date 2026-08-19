import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MonitorRegistration } from "@germ-network/atproto-pmr-monitor"
import { kvMonitorRegistrationStore } from "../src/registration-store"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv

const DID = "did:plc:alice"

function registration(overrides: Partial<MonitorRegistration> = {}): MonitorRegistration {
    return {
        did: DID,
        anchorKey: new Uint8Array([1, 2, 3, 4]),
        pushSubscription: {
            endpoint: "https://push.example/sub/1",
            contentKey: new Uint8Array(32).fill(9),
            keyId: 5,
        },
        registeredAt: 1_760_000_000,
        ...overrides,
    }
}

describe("kvMonitorRegistrationStore", () => {
    it("round-trips a registration through KV, bytes intact", async () => {
        const store = kvMonitorRegistrationStore(testEnv)
        expect(store).not.toBeNull()
        await store!.put(registration())

        const loaded = await store!.load(DID)
        expect(loaded).toEqual(registration())
    })

    it("load returns null for an unregistered DID", async () => {
        const store = kvMonitorRegistrationStore(testEnv)
        expect(await store!.load("did:plc:nobody")).toBeNull()
    })

    it("put overwrites — a rebind's new subscription replaces the old one entirely", async () => {
        const store = kvMonitorRegistrationStore(testEnv)
        await store!.put(registration())
        await store!.put(
            registration({
                pushSubscription: {
                    endpoint: "https://push.example/sub/NEW",
                    contentKey: new Uint8Array(32).fill(1),
                    keyId: 200,
                },
            })
        )
        const loaded = await store!.load(DID)
        expect(loaded?.pushSubscription.endpoint).toBe("https://push.example/sub/NEW")
    })

    it("delete removes the registration", async () => {
        const store = kvMonitorRegistrationStore(testEnv)
        await store!.put(registration())
        await store!.delete(DID)
        expect(await store!.load(DID)).toBeNull()
    })

    it("returns null when the deployment has no registrations binding", async () => {
        const unbound = { ...testEnv, registrations: undefined } as MonitorEnv
        expect(kvMonitorRegistrationStore(unbound)).toBeNull()
    })
})
