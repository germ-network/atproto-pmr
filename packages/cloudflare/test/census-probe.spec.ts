/**
 * `KVDirectory.listRouteCandidates` / `probeRegistration`: the read-only
 * census seam. Every probe must leave the registration exactly as it found it.
 */
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    binaryToBase64URL,
    encodeOkpEd25519Key,
    thumbprintOkpEd25519,
    type RegistrationFields,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv<PMRObject>
const T0 = 1_760_000_000

let counter = 0
const freshDID = () => `did:plc:census-${(counter += 1)}-${Math.random().toString(36).slice(2)}`

const anchor = (fill: number) => encodeOkpEd25519Key({ x: new Uint8Array(32).fill(fill) })
const thumb = (fill: number) => thumbprintOkpEd25519({ x: new Uint8Array(32).fill(fill) })
const fields = (did: string, fill: number, lastActive = T0): RegistrationFields => ({
    did,
    anchorKey: anchor(fill),
    lastActive,
})
const stubOf = (locator: string) => testEnv.pmrs.get(testEnv.pmrs.idFromString(locator))

let consoleSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {})
    )
})
afterEach(() => {
    vi.restoreAllMocks()
})
const consoleOutput = () => consoleSpies.flatMap((s) => s.mock.calls)

describe("listRouteCandidates", () => {
    it("returns route DIDs only, never tomb: keys", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, fields(did, 1))
        await testEnv.pmrDirectory.put(`tomb:${did}:${binaryToBase64URL(thumb(1))}`, "1")

        const seen: string[] = []
        let cursor: string | null = null
        do {
            const page = await dir.listRouteCandidates(cursor)
            seen.push(...page.dids)
            cursor = page.cursor
        } while (cursor !== null)

        expect(seen).toContain(did)
        expect(seen.every((d) => d.startsWith("did:"))).toBe(true)
        expect(seen.some((d) => d.startsWith("tomb:"))).toBe(false)
    })

    it("round-trips the cursor across more than one page, null past the last", async () => {
        const dir = new KVDirectory(testEnv)
        const tag = Math.random().toString(36).slice(2)
        const wanted = Array.from({ length: 1005 }, (_, i) => `did:plc:census-page-${tag}-${i}`)
        for (let i = 0; i < wanted.length; i += 100) {
            await Promise.all(wanted.slice(i, i + 100).map((d) => testEnv.pmrDirectory.put(d, "loc")))
        }

        const seen = new Set<string>()
        let pages = 0
        let cursor: string | null = null
        do {
            const page = await dir.listRouteCandidates(cursor)
            pages += 1
            expect(page.dids.length).toBeLessThanOrEqual(1000)
            for (const d of page.dids) seen.add(d)
            cursor = page.cursor
        } while (cursor !== null)

        expect(pages).toBeGreaterThan(1)
        for (const d of wanted) expect(seen.has(d)).toBe(true)
    })
})

describe("probeRegistration", () => {
    it("live registration → its stored lastActive", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, fields(did, 2, T0 + 123))
        expect(await dir.probeRegistration(did)).toEqual({ lastActive: T0 + 123 })
    })

    it("leaves the record byte-identical, sets no alarm and notifies no monitor", async () => {
        let monitorTouched = 0
        const monitored = {
            ...testEnv,
            MONITOR_INGEST: {
                get() {
                    monitorTouched += 1
                    throw new Error("must not be reached")
                },
                idFromName() {
                    monitorTouched += 1
                    return {}
                },
            },
            MONITOR_INGEST_NAME: "m",
        } as unknown as PMREnv<PMRObject>
        const did = freshDID()
        const locator = await new KVDirectory(testEnv).create(did, fields(did, 3))
        const snapshot = () =>
            inPMR(stubOf(locator) as never, async (pmr) => {
                const db = (pmr as unknown as { db: DurableObjectStorage }).db
                return {
                    entries: JSON.stringify([...(await db.list()).entries()]),
                    alarm: await db.getAlarm(),
                }
            })
        const before = await snapshot()

        expect(await new KVDirectory(monitored).probeRegistration(did)).toEqual({ lastActive: T0 })

        expect(await snapshot()).toEqual(before)
        expect(before.alarm).toBeNull()
        expect(monitorTouched).toBe(0)
    })

    it("route present but no record (create crash window) → null", async () => {
        const did = freshDID()
        await testEnv.pmrDirectory.put(did, testEnv.pmrs.newUniqueId().toString())
        expect(await new KVDirectory(testEnv).probeRegistration(did)).toBeNull()
    })

    it("route to a destroyed locator → null", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        const locator = await dir.create(did, fields(did, 4))
        await stubOf(locator).destroy()
        expect(await dir.probeRegistration(did)).toBeNull()
    })

    it("DID listed but route deleted before the probe → null", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, fields(did, 5))
        await testEnv.pmrDirectory.delete(did)
        expect(await dir.probeRegistration(did)).toBeNull()
    })

    it("malformed locator → null", async () => {
        const did = freshDID()
        await testEnv.pmrDirectory.put(did, "not-a-locator")
        expect(await new KVDirectory(testEnv).probeRegistration(did)).toBeNull()
    })

    it("record did mismatched or missing → null", async () => {
        const dir = new KVDirectory(testEnv)
        const didA = freshDID()
        const didB = freshDID()
        await dir.create(didA, fields(didB, 6))
        expect(await dir.probeRegistration(didA)).toBeNull()

        const didC = freshDID()
        await dir.create(didC, { anchorKey: anchor(7), lastActive: T0 } as RegistrationFields)
        expect(await dir.probeRegistration(didC)).toBeNull()
    })

    it("unparsable stored anchorKey → null", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, { did, anchorKey: new Uint8Array([1, 2, 3]), lastActive: T0 })
        expect(await dir.probeRegistration(did)).toBeNull()
    })

    it("routed but tombstoned (deregister crash window) → null", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, fields(did, 8))
        await testEnv.pmrDirectory.put(`tomb:${did}:${binaryToBase64URL(thumb(8))}`, "1")
        expect(await dir.probeRegistration(did)).toBeNull()
    })

    it("a tombstone for a previous anchor does not exclude the current one", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        await dir.create(did, fields(did, 15, T0 + 5))
        await testEnv.pmrDirectory.put(`tomb:${did}:${binaryToBase64URL(thumb(16))}`, "1")
        expect(await dir.probeRegistration(did)).toEqual({ lastActive: T0 + 5 })
    })

    it("different-key replace between list and probe → reads only the new incarnation", async () => {
        const dir = new KVDirectory(testEnv)
        const did = freshDID()
        const oldLocator = await dir.create(did, fields(did, 9, T0 + 1))
        const listed = new Set<string>()
        let cursor: string | null = null
        do {
            const page = await dir.listRouteCandidates(cursor)
            page.dids.forEach((d) => listed.add(d))
            cursor = page.cursor
        } while (cursor !== null)
        expect(listed.has(did)).toBe(true)
        await dir.delete(did)
        const newLocator = await dir.create(did, fields(did, 10, T0 + 2))
        expect(newLocator).not.toBe(oldLocator)

        expect(await dir.probeRegistration(did)).toEqual({ lastActive: T0 + 2 })
        expect(await stubOf(oldLocator).load()).toBeNull()
    })

    it("logs nothing naming the DID on any branch, including a throwing load", async () => {
        const dir = new KVDirectory(testEnv)
        const live = freshDID()
        await dir.create(live, fields(live, 11))
        const mismatch = freshDID()
        await dir.create(mismatch, fields(freshDID(), 12))
        const malformed = freshDID()
        await testEnv.pmrDirectory.put(malformed, "not-a-locator")
        const bad = freshDID()
        await dir.create(bad, { did: bad, anchorKey: new Uint8Array([1]), lastActive: T0 })
        const tombstoned = freshDID()
        await dir.create(tombstoned, fields(tombstoned, 13))
        await testEnv.pmrDirectory.put(`tomb:${tombstoned}:${binaryToBase64URL(thumb(13))}`, "1")
        const orphan = freshDID()
        await testEnv.pmrDirectory.put(orphan, testEnv.pmrs.newUniqueId().toString())
        for (const did of [live, mismatch, malformed, bad, tombstoned, orphan, freshDID()]) {
            await dir.probeRegistration(did)
        }

        const throwing = freshDID()
        await dir.create(throwing, fields(throwing, 14))
        const failing = {
            ...testEnv,
            pmrs: {
                idFromString: (s: string) => testEnv.pmrs.idFromString(s),
                get: () => ({
                    load: async () => {
                        throw new Error(throwing)
                    },
                }),
            },
        } as unknown as PMREnv<PMRObject>
        await expect(new KVDirectory(failing).probeRegistration(throwing)).rejects.toThrow()

        expect(consoleOutput()).toEqual([])
    })
})
