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

const RETENTION = 30 * 86400

function fields(did: string, fill: number): RegistrationFields {
    return {
        did,
        anchorKey: encodeOkpEd25519Key({ x: new Uint8Array(32).fill(fill) }),
        lastActive: T0,
    }
}
const thumb = (fill: number) =>
    thumbprintOkpEd25519({ x: new Uint8Array(32).fill(fill) })

/** The inactive locators of the DID's row, newest first. */
async function inactiveOf(did: string): Promise<string[]> {
    const raw = await testEnv.pmrDirectory.get(did)
    if (raw === null || !raw.startsWith("{")) return []
    return (JSON.parse(raw).i as Array<{ l: string }>).map((e) => e.l)
}

describe("delete", () => {
    it("tears down the active registration's Durable Object, not just the routing row", async () => {
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

    it("leaves the inactive set alone", async () => {
        const dir = directory()
        const did = freshDID()
        const first = await dir.create(did, fields(did, 1))
        await dir.deactivate(did, T0, first)
        await dir.create(did, fields(did, 2))
        await dir.delete(did)
        expect(await dir.resolve(did)).toBeNull()
        expect(await inactiveOf(did)).toEqual([first])
        expect(await pmrStore(first, testEnv).load()).not.toBeNull()
    })
})

describe("registration sets", () => {
    it("a row written before registration sets reads as one active registration", async () => {
        const did = freshDID()
        await testEnv.pmrDirectory.put(did, "legacy-locator")
        expect(await directory().resolve(did)).toBe("legacy-locator")
    })

    it("deactivate moves the active registration to the inactive set and marks its object inactive", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))

        expect(await dir.deactivate(did, T0, locator)).toBe(locator)

        expect(await dir.resolve(did)).toBeNull()
        expect(await inactiveOf(did)).toEqual([locator])
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
        expect(await dir.resolve(did)).toBe(second)
        expect(await pmrStore(second, testEnv).readInactive()).toBeNull()
    })

    it("a retried deactivate records the object's first times in the row", async () => {
        const dir = directory()
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 1))
        await pmrStore(locator, testEnv).markInactive(T0, T0 + 99)
        await dir.deactivate(did, T0 + 500, locator)
        const row = JSON.parse((await testEnv.pmrDirectory.get(did))!)
        expect(row.i).toEqual([{ l: locator, at: T0, until: T0 + 99 }])
    })

    it("deactivate drops inactive entries past retention from the row", async () => {
        const dir = directory()
        const did = freshDID()
        const first = await dir.create(did, fields(did, 1))
        await dir.deactivate(did, T0, first)
        const second = await dir.create(did, fields(did, 2))
        await dir.deactivate(did, T0 + RETENTION, second)
        expect(await inactiveOf(did)).toEqual([second])
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
        expect(await inactiveOf(did)).toEqual([locators[2], locators[1]])
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
        expect(await dir.resolve(did)).toBe(second)
        expect(await inactiveOf(did)).toEqual([first])
        expect(await dir.create(did, fields(did, 2))).toBe(second)
    })

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

    it("a tombstone survives a later delete, deactivate or create of the row", async () => {
        const dir = directory()
        const did = freshDID()
        await dir.create(did, fields(did, 1))
        await dir.deregister(did, thumb(1))
        const second = await dir.create(did, fields(did, 2))
        await dir.deactivate(did, T0, second)
        await dir.delete(did)
        await dir.create(did, fields(did, 3))
        await dir.delete(did)
        expect(await dir.isTombstoned(did, thumb(1))).toBe(true)
    })
})
