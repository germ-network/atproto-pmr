/**
 * `PMRObject.touchActive`: first authenticated owner interaction per UTC day,
 * monotonic, never creating or resurrecting a registration.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { encodeOkpEd25519Key, type RegistrationFields } from "@germ-network/atproto-pmr-core"
import { KVDirectory } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

const testEnv = env as unknown as PMREnv<PMRObject>
const DAY = 86_400
const MIDNIGHT = 20_000 * DAY
const KEY = encodeOkpEd25519Key({ x: new Uint8Array(32).fill(1) })

let counter = 0
async function registered(overrides: Partial<RegistrationFields> = {}) {
    const did = `did:plc:touch-${(counter += 1)}`
    const locator = await new KVDirectory(testEnv).create(did, {
        did,
        anchorKey: KEY,
        lastActive: MIDNIGHT - 10,
        ...overrides,
    })
    const stub = testEnv.pmrs.get(testEnv.pmrs.idFromString(locator))
    return { stub, lastActive: async () => (await stub.load())?.lastActive }
}

describe("touchActive", () => {
    it("first touch on a later UTC day writes nowSeconds", async () => {
        const r = await registered()
        await r.stub.touchActive(MIDNIGHT + 5_000, KEY)
        expect(await r.lastActive()).toBe(MIDNIGHT + 5_000)
    })

    it("a second touch the same UTC day leaves lastActive unchanged", async () => {
        const r = await registered()
        await r.stub.touchActive(MIDNIGHT + 5_000, KEY)
        await r.stub.touchActive(MIDNIGHT + 9_000, KEY)
        expect(await r.lastActive()).toBe(MIDNIGHT + 5_000)
    })

    it("a same-day or earlier nowSeconds never decreases lastActive", async () => {
        const r = await registered({ lastActive: MIDNIGHT + 8_000 })
        await r.stub.touchActive(MIDNIGHT + 100, KEY)
        await r.stub.touchActive(MIDNIGHT - 5 * DAY, KEY)
        expect(await r.lastActive()).toBe(MIDNIGHT + 8_000)
    })

    it("23:59:59 → 00:00:00 UTC writes", async () => {
        const r = await registered({ lastActive: MIDNIGHT - 1 })
        await r.stub.touchActive(MIDNIGHT, KEY)
        expect(await r.lastActive()).toBe(MIDNIGHT)
    })

    it("no registration → no write, and none is created", async () => {
        const stub = testEnv.pmrs.get(testEnv.pmrs.newUniqueId())
        await stub.touchActive(MIDNIGHT + 1, KEY)
        expect(await stub.load()).toBeNull()
    })

    it("after destroy() → no registration is resurrected", async () => {
        const r = await registered()
        await r.stub.destroy()
        await r.stub.touchActive(MIDNIGHT + 1, KEY)
        expect(await r.stub.load()).toBeNull()
    })

    it("registration without a did → no write", async () => {
        const r = await registered({ did: undefined } as never)
        await r.stub.touchActive(MIDNIGHT + 1, KEY)
        expect(await r.lastActive()).toBe(MIDNIGHT - 10)
    })

    it("anchorKey given and different → no write", async () => {
        const r = await registered()
        await r.stub.touchActive(MIDNIGHT + 1, encodeOkpEd25519Key({ x: new Uint8Array(32).fill(2) }))
        expect(await r.lastActive()).toBe(MIDNIGHT - 10)
    })

    it("non-finite stored lastActive → no write", async () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
            const r = await registered({ lastActive: bad })
            await r.stub.touchActive(MIDNIGHT + 1, KEY)
            expect(await r.lastActive()).toBe(bad)
        }
    })
})
