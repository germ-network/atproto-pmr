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

describe("deregister", () => {
    it("tears down the registration's Durable Object, not just the routing row", async () => {
        const dir = directory()
        const did = freshDID()
        const x = new Uint8Array(32).fill(1)
        const fields: RegistrationFields = {
            did,
            anchorKey: encodeOkpEd25519Key({ x }),
            lastActive: T0,
        }

        const locator = await dir.create(did, fields)
        const store = pmrStore(locator, testEnv)
        const appended = await store.append(
            asPairMailboxKey("did:plc:some-sender"),
            { messageId: "m1", byteLength: 42 },
            new Uint8Array(16).fill(2),
            T0
        )
        expect(appended.outcome).toBe("appended")

        await dir.deregister(did, thumbprintOkpEd25519({ x }))

        // Unlinked: the DID no longer resolves.
        expect(await dir.resolve(did)).toBeNull()
        // Torn down, not merely orphaned: the old DO's state is gone too.
        expect(await store.load()).toBeNull()
        const page = await store.openMailboxes(null, 100)
        expect(page.entries).toEqual([])
    })
})

describe("registration sets", () => {
    const RETENTION = 30 * 86400

    function fields(did: string, fill: number): RegistrationFields {
        return { did, anchorKey: new Uint8Array(32).fill(fill), lastActive: T0 }
    }

    it("a row written before registration sets reads as one active registration", async () => {
        const did = freshDID()
        await testEnv.pmrDirectory.put(did, "legacy-locator")
        const dir = directory()
        expect(await dir.resolve(did)).toBe("legacy-locator")
        expect(await dir.registrations(did, T0)).toEqual({
            active: "legacy-locator",
            inactive: [],
        })
    })

    it("deactivate moves the active registration to the inactive set and marks its object inactive", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))

        expect(await dir.deactivate(did, T0, locator)).toBe(locator)

        expect(await dir.resolve(did)).toBeNull()
        const set = await dir.registrations(did, T0)
        expect(set.active).toBeNull()
        expect(set.inactive).toHaveLength(1)
        expect(set.inactive[0]!.locator).toBe(locator)
        expect([...set.inactive[0]!.anchorKey]).toEqual([...new Uint8Array(32).fill(1)])
        expect(set.inactive[0]!.destroyAt).toBe(T0 + RETENTION)
        expect(await pmrStore(locator, testEnv).readInactive()).toEqual({
            inactiveAt: T0,
            destroyAt: T0 + RETENTION,
        })
    })

    it("deactivate with no active registration returns null and changes nothing", async () => {
        const dir = directory()
        const did = freshDID()
        expect(await dir.deactivate(did, T0, "loc")).toBeNull()
        expect(await testEnv.pmrDirectory.get(did)).toBeNull()
    })

    it("deactivate does nothing when the active registration is not the expected one", async () => {
        const dir = directory()
        const did = freshDID()
        const first = await dir.create(did, fields(did, 1))
        await dir.deactivate(did, T0, first)
        const second = await dir.create(did, fields(did, 2))

        expect(await dir.deactivate(did, T0 + 1, first)).toBeNull()
        expect((await dir.registrations(did, T0 + 1)).active).toBe(second)
        expect(await pmrStore(second, testEnv).readInactive()).toBeNull()
    })

    it("registrations omits inactive entries past retention", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))
        await dir.deactivate(did, T0, locator)
        expect((await dir.registrations(did, T0 + RETENTION - 1)).inactive).toHaveLength(1)
        expect((await dir.registrations(did, T0 + RETENTION)).inactive).toHaveLength(0)
    })

    it("past the inactive cap, deactivate destroys the oldest inactive registration", async () => {
        const dir = new KVDirectory(testEnv, {
            inactiveRetentionSeconds: RETENTION,
            maxInactive: 2,
        })
        const did = freshDID()
        const locators: string[] = []
        for (let n = 1; n <= 3; n++) {
            locators.push(await dir.create(did, fields(did, n)))
            await dir.deactivate(did, T0 + n, locators[n - 1]!)
        }
        const set = await dir.registrations(did, T0 + 3)
        expect(set.inactive.map((e) => e.locator)).toEqual([locators[2], locators[1]])
        expect(await pmrStore(locators[0]!, testEnv).load()).toBeNull()
        expect(await pmrStore(locators[1]!, testEnv).load()).not.toBeNull()
    })

    it("create after deactivate allocates a fresh object and keeps the inactive set", async () => {
        const dir = directory()
        const did = freshDID()
        const first = await dir.create(did, fields(did, 1))
        await dir.deactivate(did, T0, first)
        const second = await dir.create(did, fields(did, 2))

        expect(second).not.toBe(first)
        const set = await dir.registrations(did, T0)
        expect(set.active).toBe(second)
        expect(set.inactive.map((e) => e.locator)).toEqual([first])
        expect(await dir.create(did, fields(did, 2))).toBe(second)
    })

    function cose(fill: number): RegistrationFields {
        return {
            did: "",
            anchorKey: encodeOkpEd25519Key({ x: new Uint8Array(32).fill(fill) }),
            lastActive: T0,
        }
    }
    const thumb = (fill: number) =>
        thumbprintOkpEd25519({ x: new Uint8Array(32).fill(fill) })

    it("deregister tombstones only that anchor", async () => {
        const dir = directory()
        const did = freshDID()
        await dir.create(did, { ...cose(1), did })

        await dir.deregister(did, thumb(2))
        expect(await dir.resolve(did)).not.toBeNull()
        expect(await dir.isTombstoned(did, thumb(2))).toBe(false)

        await dir.deregister(did, thumb(1))
        expect(await dir.resolve(did)).toBeNull()
        expect(await dir.isTombstoned(did, thumb(1))).toBe(true)
        expect(await dir.isTombstoned(did, thumb(2))).toBe(false)
        expect(await dir.isTombstoned(freshDID(), thumb(1))).toBe(false)
    })

    it("a tombstone survives a later deactivate or create of the row", async () => {
        const dir = directory()
        const did = freshDID()
        await dir.create(did, { ...cose(1), did })
        await dir.deregister(did, thumb(1))
        const second = await dir.create(did, { ...cose(2), did })
        await dir.deactivate(did, T0, second)
        await dir.create(did, { ...cose(3), did })
        expect(await dir.isTombstoned(did, thumb(1))).toBe(true)
    })
})
