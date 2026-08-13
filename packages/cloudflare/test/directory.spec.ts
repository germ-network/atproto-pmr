/**
 * `KVDirectory`'s grant-routing rows: the global address -> {locator,
 * authKey, closed} lookup a grant put resolves against before any relay is
 * known.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { KVDirectory } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

const testEnv = env as unknown as PMREnv<PMRObject>

const T0 = Math.floor(Date.now() / 1000)

function directory(): KVDirectory {
    return new KVDirectory(testEnv)
}

let counter = 0
function freshAddress(): string {
    counter += 1
    return `addr-${counter}`
}

describe("createGrantAddress / resolveAddress", () => {
    it("round-trips locator, authKey, and closed:false", async () => {
        const dir = directory()
        const address = freshAddress()
        const authKey = new Uint8Array(32).fill(7)

        await dir.createGrantAddress("loc:owner", address, authKey, T0 + 3600)

        const resolved = await dir.resolveAddress(address)
        expect(resolved).not.toBeNull()
        expect(resolved!.locator).toBe("loc:owner")
        expect(resolved!.closed).toBe(false)
        expect([...resolved!.authKey]).toEqual([...authKey])
    })

    it("an address that was never issued resolves to null", async () => {
        const dir = directory()
        expect(await dir.resolveAddress(freshAddress())).toBeNull()
    })
})

describe("setGrantAddressClosed", () => {
    it("flips closed without disturbing locator or authKey", async () => {
        const dir = directory()
        const address = freshAddress()
        const authKey = new Uint8Array(32).fill(3)
        await dir.createGrantAddress("loc:owner", address, authKey, T0 + 3600)

        await dir.setGrantAddressClosed(address, true)
        const closed = await dir.resolveAddress(address)
        expect(closed!.closed).toBe(true)
        expect([...closed!.authKey]).toEqual([...authKey])
        expect(closed!.locator).toBe("loc:owner")

        // Reversible.
        await dir.setGrantAddressClosed(address, false)
        expect((await dir.resolveAddress(address))!.closed).toBe(false)
    })

    it("is a no-op on an address that does not exist", async () => {
        const dir = directory()
        const address = freshAddress()
        // Must not throw, and must not create a row.
        await dir.setGrantAddressClosed(address, true)
        expect(await dir.resolveAddress(address)).toBeNull()
    })
})

describe("deleteGrantAddress", () => {
    it("removes the row entirely — a put afterward resolves to null, not closed:true", async () => {
        const dir = directory()
        const address = freshAddress()
        await dir.createGrantAddress(
            "loc:owner",
            address,
            new Uint8Array(32),
            T0 + 3600
        )

        await dir.deleteGrantAddress(address)

        expect(await dir.resolveAddress(address)).toBeNull()
    })

    it("is a no-op on an address that does not exist", async () => {
        const dir = directory()
        await dir.deleteGrantAddress(freshAddress())
    })
})
