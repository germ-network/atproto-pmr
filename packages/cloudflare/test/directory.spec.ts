/**
 * `KVDirectory`'s grant-routing rows: the global address -> {locator,
 * authKey, closed} lookup a grant put resolves against before any relay is
 * known.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    asPairMailboxKey,
    encodeOkpEd25519Key,
    thumbprintOkpEd25519,
    type RegistrationFields,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory, pmrStore } from "../src/directory"
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

let didCounter = 0
function freshDID(): string {
    didCounter += 1
    return `did:plc:directory-test-${didCounter}`
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

function fields(did: string, fill: number): RegistrationFields {
    return {
        did,
        anchorKey: encodeOkpEd25519Key({ x: new Uint8Array(32).fill(fill) }),
        lastActive: T0,
    }
}
const thumb = (fill: number) =>
    thumbprintOkpEd25519({ x: new Uint8Array(32).fill(fill) })

describe("delete", () => {
    it("tears down the registration's Durable Object, not just the routing row", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))
        const store = pmrStore(locator, testEnv)
        const appended = await store.append(
            asPairMailboxKey("did:plc:some-sender"),
            { messageId: "m1", byteLength: 42 },
            new Uint8Array(16).fill(2),
            T0
        )
        expect(appended.outcome).toBe("appended")

        await dir.delete(did)

        expect(await dir.resolve(did)).toBeNull()
        expect(await store.load()).toBeNull()
        expect((await store.openMailboxes(null, 100)).entries).toEqual([])
    })
})

describe("retire", () => {
    it("destroys the expected active registration with its mail and does not tombstone it", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))
        const store = pmrStore(locator, testEnv)
        await store.append(
            asPairMailboxKey("did:plc:some-sender"),
            { messageId: "m1", byteLength: 42 },
            new Uint8Array(16).fill(2),
            T0
        )

        expect(await dir.retire(did, locator)).toBe(locator)

        expect(await dir.resolve(did)).toBeNull()
        expect(await store.load()).toBeNull()
        expect(await dir.isTombstoned(did, thumb(1))).toBe(false)
    })

    it("does nothing when the active registration is not the expected one", async () => {
        const dir = directory()
        const did = freshDID()
        const first = await dir.create(did, fields(did, 1))
        await dir.delete(did)
        const second = await dir.create(did, fields(did, 2))

        expect(await dir.retire(did, first)).toBeNull()
        expect(await dir.resolve(did)).toBe(second)
        expect(await pmrStore(second, testEnv).load()).not.toBeNull()
    })

    it("does nothing when the DID has no registration", async () => {
        expect(await directory().retire(freshDID(), "loc")).toBeNull()
    })
})

describe("tombstones", () => {
    it("deregister tombstones only that anchor", async () => {
        const dir = directory()
        const did = freshDID()
        await dir.create(did, fields(did, 1))

        await dir.deregister(did, thumb(2))
        expect(await dir.resolve(did)).not.toBeNull()
        expect(await dir.isTombstoned(did, thumb(2))).toBe(false)

        await dir.deregister(did, thumb(1))
        expect(await dir.resolve(did)).toBeNull()
        expect(await dir.isTombstoned(did, thumb(1))).toBe(true)
        expect(await dir.isTombstoned(did, thumb(2))).toBe(false)
        expect(await dir.isTombstoned(freshDID(), thumb(1))).toBe(false)
    })

    it("a tombstone survives a later delete, retire or create", async () => {
        const dir = directory()
        const did = freshDID()
        await dir.create(did, fields(did, 1))
        await dir.deregister(did, thumb(1))
        const second = await dir.create(did, fields(did, 2))
        await dir.retire(did, second)
        await dir.create(did, fields(did, 3))
        await dir.delete(did)
        expect(await dir.isTombstoned(did, thumb(1))).toBe(true)
    })
})
