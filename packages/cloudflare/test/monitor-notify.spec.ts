/**
 * A relay bound to a monitor tells it about every registration and
 * deregistration, and never lets the monitor's failure fail the directory
 * write.
 */
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import {
    encodeOkpEd25519Key,
    thumbprintOkpEd25519,
    type RegistrationFields,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"

const testEnv = env as unknown as PMREnv<PMRObject>

const T0 = Math.floor(Date.now() / 1000)

let didCounter = 0
/** A fresh DID per test — the ingest stub's record persists across tests. */
function freshDID(): string {
    didCounter += 1
    return `did:plc:notify-test-${didCounter}`
}

function registration(did: string): RegistrationFields {
    return { did, anchorKey: new Uint8Array(32), lastActive: 1_760_000_000 }
}

function ingest() {
    const ns = testEnv.MONITOR_INGEST!
    return ns.get(
        ns.idFromName(testEnv.MONITOR_INGEST_NAME!)
    ) as unknown as DurableObjectStub<MonitorIngestStub>
}

async function callsFor(did: string): Promise<string[]> {
    return (await ingest().calls()).filter(c => c.endsWith(`:${did}`))
}

describe("KVDirectory monitor notify", () => {
    it("create notifies register when bound", async () => {
        const did = freshDID()
        await new KVDirectory(testEnv).create(did, registration(did))
        expect(await callsFor(did)).toEqual([`register:${did}`])
        expect((await ingest().rowSeen())[`register:${did}`]).toBe(true)
    })

    it("create of an existing DID still notifies register", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        await directory.create(did, registration(did))
        await directory.create(did, registration(did))
        expect(await callsFor(did)).toEqual([`register:${did}`, `register:${did}`])
    })

    it("delete notifies unregister when bound", async () => {
        const did = freshDID()
        const directory = new KVDirectory(testEnv)
        await directory.create(did, registration(did))
        await directory.delete(did)
        expect(await callsFor(did)).toEqual([`register:${did}`, `unregister:${did}`])
        expect((await ingest().rowSeen())[`unregister:${did}`]).toBe(false)
    })

    it("deactivate and deregister notify unregister when bound", async () => {
        const x = new Uint8Array(32).fill(5)
        const directory = new KVDirectory(testEnv)

        const a = freshDID()
        const locator = await directory.create(a, registration(a))
        await directory.deactivate(a, T0, locator)
        expect(await callsFor(a)).toEqual([`register:${a}`, `unregister:${a}`])

        const b = freshDID()
        await directory.create(b, { ...registration(b), anchorKey: encodeOkpEd25519Key({ x }) })
        await directory.deregister(b, thumbprintOkpEd25519({ x }))
        expect(await callsFor(b)).toEqual([`register:${b}`, `unregister:${b}`])
        expect((await ingest().rowSeen())[`unregister:${b}`]).toBe(false)
    })

    it("an unbound monitor is a no-op", async () => {
        const did = freshDID()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            for (const unbound of [
                { ...testEnv, MONITOR_INGEST: undefined },
                { ...testEnv, MONITOR_INGEST_NAME: undefined },
            ]) {
                const directory = new KVDirectory(unbound)
                await directory.create(did, registration(did))
                await directory.delete(did)
            }
            expect(await callsFor(did)).toEqual([])
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
        }
    })

    it("a failing monitor call does not fail the directory write", async () => {
        const did = freshDID()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const failing = {
            ...testEnv,
            MONITOR_INGEST: {
                idFromName: () => ({}),
                get: () => ({
                    register: () => Promise.reject(new Error("monitor down")),
                    unregister: () => Promise.reject(new Error("monitor down")),
                }),
            } as unknown as DurableObjectNamespace,
        }
        const directory = new KVDirectory(failing)
        try {
            const locator = await directory.create(did, registration(did))
            expect(await directory.resolve(did)).toBe(locator)
            await directory.delete(did)
            expect(await directory.resolve(did)).toBeNull()
            expect(warn).toHaveBeenCalledTimes(2)
        } finally {
            warn.mockRestore()
        }
    })
})
