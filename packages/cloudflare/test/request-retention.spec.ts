/**
 * A request entry leaves once the retention that governs its body expires,
 * whatever else its sender holds: the owner's listing never shows one and a
 * periodic sweep returns their bytes to the shared quota. A sender's own put
 * does not purge, so its depth and quota are freed by the next listing or
 * sweep.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Admission, MessageRef, Nonce, PairMailboxEvidence, PairMailboxKey } from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv
const NOW = () => Math.floor(Date.now() / 1000)
const YES: Admission = { verdict: "yes" }
const NO: Admission = { verdict: "no", why: ["stub"] }
const GRACE = 300
const DAY = 86_400

const did = (name: string) => `did:plc:${name}` as PairMailboxKey
const ref = (id: string, byteLength = 100): MessageRef => ({ messageId: id, byteLength })
const evidence = (who: PairMailboxKey): PairMailboxEvidence => ({
    senderDID: who,
    anchorKey: new Uint8Array(32).fill(7),
    declarationCID: "bafy-selected",
    revision: "5555555555555",
    car: new Uint8Array(1000),
    expiresAt: NOW() + 3_600,
})

let nonceCounter = 0
const freshNonce = (): Nonce => {
    nonceCounter += 1
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setUint32(0, nonceCounter)
    return bytes
}
let counter = 0
const freshStub = () => testEnv.pmrs.get(testEnv.pmrs.idFromName(`request-retention-${++counter}`))
const storageOf = (pmr: PMRObject) => (pmr as unknown as { db: DurableObjectStorage }).db
const reqBytes = async (pmr: PMRObject) => (await storageOf(pmr).get<number>("reqBytes")) ?? 0
const listed = async (pmr: PMRObject) =>
    (await pmr.requestMailboxes(null, 100)).entries.map((e) => [e.key, e.messageIds] as const)

const hold = (pmr: PMRObject, who: PairMailboxKey, id: string, bytes = 100) =>
    pmr.appendToRequest(who, ref(id, bytes), freshNonce(), NOW())

/** Makes every request entry of `who` old enough to be judged by its body. */
async function age(pmr: PMRObject, who: PairMailboxKey, seconds = GRACE + 60) {
    const refs = (await storageOf(pmr).get<MessageRef[]>(`req:${who}`))!
    await storageOf(pmr).put(`req:${who}`, refs.map((r) => ({ ...r, heldAt: NOW() - seconds })))
}
const withBody = (id: string) => testEnv.messages.put(id, new Uint8Array([1]))

describe("request entries and body retention", () => {
    it("lists no entry whose body has expired, and returns its bytes to the quota", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "gone-a", 100)
            await hold(pmr, did("a"), "kept-a", 50)
            await age(pmr, did("a"))
            await withBody("kept-a")
            expect(await listed(pmr)).toEqual([[did("a"), ["kept-a"]]])
            expect(await reqBytes(pmr)).toBe(50)
            expect(await pmr.getMessage(did("a"), "gone-a")).toBeNull()
        })
    })

    it("keeps an entry younger than the grace window whose body is not stored yet", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "fresh")
            expect(await listed(pmr)).toEqual([[did("a"), ["fresh"]]])
        })
    })

    it("drops a sender whose every body expired, with its proof row and bytes", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("other"), "o1", 10)
            await pmr.appendPair(did("a"), ref("m1"), freshNonce(), NOW(), evidence(did("a")))
            expect(await reqBytes(pmr)).toBe(10 + 1100)
            await age(pmr, did("a"))
            expect(await listed(pmr)).toEqual([[did("other"), ["o1"]]])
            expect(await storageOf(pmr).get(`pairEvidence:${did("a")}`)).toBeUndefined()
            expect(await reqBytes(pmr)).toBe(10)
        })
    })

    it("lets a sender that also holds a pair mailbox lose request entries whose body expired", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendPair(did("a"), ref("deep"), freshNonce(), NOW(), evidence(did("a")), YES)
            await pmr.appendPair(did("a"), ref("held"), freshNonce(), NOW(), evidence(did("a")), NO)
            await age(pmr, did("a"))
            expect(await listed(pmr)).toEqual([])
            expect((await pmr.list(did("a"), 10)).map((r) => r.messageId)).toEqual(["deep"])
            expect(await reqBytes(pmr)).toBe(0)
        })
    })

    it("lets an entry held with no proof row leave when its body expires", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            expect(await storageOf(pmr).get(`pairEvidence:${did("a")}`)).toBeUndefined()
            await age(pmr, did("a"))
            expect(await listed(pmr)).toEqual([])
            expect(await reqBytes(pmr)).toBe(0)
        })
    })

    it("frees a sender's depth once a listing has dropped its expired entries", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < 5; i++) await hold(pmr, did("a"), `old${i}`)
            await age(pmr, did("a"))
            expect(await listed(pmr)).toEqual([])
            expect((await hold(pmr, did("a"), "new")).outcome).toBe("held")
            expect(await listed(pmr)).toEqual([[did("a"), ["new"]]])
            expect(await reqBytes(pmr)).toBe(100)
        })
    })

    it("does not overwrite an entry that landed while the body store was consulted", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "old", 100)
            await age(pmr, did("a"))
            const base = (pmr as unknown as { env: Record<string, unknown> }).env
            let raced = false
            Object.defineProperty(pmr, "env", {
                configurable: true,
                value: {
                    ...base,
                    messages: {
                        get: async () => {
                            if (!raced) {
                                raced = true
                                await hold(pmr, did("a"), "concurrent", 30)
                            }
                            return null
                        },
                    },
                },
            })
            expect(await listed(pmr)).toEqual([])
            expect((await storageOf(pmr).get<MessageRef[]>(`req:${did("a")}`))?.map((r) => r.messageId)).toEqual(["concurrent"])
            expect(await reqBytes(pmr)).toBe(30)
        })
    })

    it("keeps entries when the body store cannot be read", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            await age(pmr, did("a"))
            const base = (pmr as unknown as { env: Record<string, unknown> }).env
            Object.defineProperty(pmr, "env", {
                configurable: true,
                value: { ...base, messages: { get: async () => { throw new Error("kv down") } } },
            })
            expect(await listed(pmr)).toEqual([[did("a"), ["m1"]]])
            expect(await reqBytes(pmr)).toBe(100)
        })
    })

    it("judges entries by an overridden body probe", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            await age(pmr, did("a"))
            ;(pmr as unknown as { bodyStored: (id: string) => Promise<boolean> }).bodyStored = async () => true
            expect(await listed(pmr)).toEqual([[did("a"), ["m1"]]])
        })
    })

    it("hands out no internal bookkeeping on a fetched or moved entry", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            expect(await pmr.getMessage(did("a"), "m1")).toEqual(ref("m1"))
            const result = await pmr.receive(did("a"), ref("deep"), freshNonce(), NOW(), YES)
            expect(result).toEqual({ outcome: "queued", persistBody: true, moved: [ref("m1")] })
            expect(await pmr.list(did("a"), 10)).toEqual([ref("m1"), ref("deep")])
        })
    })
})

describe("the request sweep", () => {
    it("is armed by the first held entry, a day out", async () => {
        await inPMR(freshStub(), async (pmr) => {
            expect(await storageOf(pmr).get("reqSweepAt")).toBeUndefined()
            await hold(pmr, did("a"), "m1")
            const at = (await storageOf(pmr).get<number>("reqSweepAt"))!
            expect(at).toBeGreaterThanOrEqual(NOW() + DAY - 5)
            expect(at).toBeLessThanOrEqual(NOW() + DAY + 5)
            const alarm = await storageOf(pmr).getAlarm()
            expect(alarm).not.toBeNull()
            expect(alarm!).toBeLessThanOrEqual(at * 1000)
        })
    })

    it("reclaims entries whose body expired and returns their bytes, then re-arms while entries remain", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "gone", 100)
            await hold(pmr, did("b"), "kept", 40)
            await age(pmr, did("a"))
            await age(pmr, did("b"))
            await withBody("kept")
            await storageOf(pmr).put("reqSweepAt", NOW() - 1)
            await storageOf(pmr).deleteAlarm()
            await pmr.alarm()
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeUndefined()
            expect((await storageOf(pmr).get<MessageRef[]>(`req:${did("b")}`))?.map((r) => r.messageId)).toEqual(["kept"])
            expect(await reqBytes(pmr)).toBe(40)
            const next = (await storageOf(pmr).get<number>("reqSweepAt"))!
            expect(next).toBeGreaterThan(NOW() + DAY - 5)
            expect((await storageOf(pmr).getAlarm())!).toBeLessThanOrEqual(next * 1000)
        })
    })

    it("disarms once no request entry is left", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "gone")
            await age(pmr, did("a"))
            await storageOf(pmr).put("reqSweepAt", NOW() - 1)
            await storageOf(pmr).deleteAlarm()
            await pmr.alarm()
            expect(await storageOf(pmr).get("reqSweepAt")).toBeUndefined()
            expect(await storageOf(pmr).getAlarm()).toBeNull()
        })
    })

    it("leaves entries alone before it is due and keeps the earlier proof-expiry alarm", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await pmr.appendPair(did("a"), ref("m1"), freshNonce(), NOW(), evidence(did("a")))
            await age(pmr, did("a"))
            await pmr.alarm()
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeDefined()
            const alarm = (await storageOf(pmr).getAlarm())!
            expect(alarm).toBeLessThanOrEqual((NOW() + 3_600) * 1000)
        })
    })

    it("keeps the sweep scheduled when an alarm fires before it is due and no proof is left", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            const dueAt = (await storageOf(pmr).get<number>("reqSweepAt"))!
            await storageOf(pmr).deleteAlarm()
            await pmr.alarm()
            expect(await storageOf(pmr).getAlarm()).toBe(dueAt * 1000)
            expect(await storageOf(pmr).get(`req:${did("a")}`)).toBeDefined()
        })
    })

    it("re-arms a sweep whose alarm was lost when the next entry is held", async () => {
        await inPMR(freshStub(), async (pmr) => {
            await hold(pmr, did("a"), "m1")
            await storageOf(pmr).put("reqSweepAt", NOW() - 10)
            await storageOf(pmr).deleteAlarm()
            await hold(pmr, did("a"), "m2")
            const alarm = await storageOf(pmr).getAlarm()
            expect(alarm).not.toBeNull()
            expect(alarm!).toBeLessThanOrEqual(Date.now() + 2_000)
        })
    })

    it("continues from its cursor and finishes with a day-out re-arm", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < 60; i++) {
                const who = did(`k${String(i).padStart(3, "0")}`)
                await hold(pmr, who, `live${i}`, 1)
                await age(pmr, who)
                await withBody(`live${i}`)
            }
            await storageOf(pmr).put("reqSweepAt", NOW() - 1)
            await pmr.alarm()
            const cursor = await storageOf(pmr).get<string>("reqSweepCursor")
            expect(cursor).toBe(`req:${did("k049")}`)
            await storageOf(pmr).deleteAlarm()
            await pmr.alarm()
            expect(await storageOf(pmr).get("reqSweepCursor")).toBeUndefined()
            expect((await storageOf(pmr).get<number>("reqSweepAt"))!).toBeGreaterThan(NOW() + DAY - 5)
            expect(await reqBytes(pmr)).toBe(60)
        })
    })

    it("pages through more senders than one pass handles", async () => {
        await inPMR(freshStub(), async (pmr) => {
            for (let i = 0; i < 60; i++) {
                const who = did(`s${String(i).padStart(3, "0")}`)
                await hold(pmr, who, `m${i}`, 1)
                await age(pmr, who)
            }
            await storageOf(pmr).put("reqSweepAt", NOW() - 1)
            await pmr.alarm()
            expect(await storageOf(pmr).get("reqSweepCursor")).toBeDefined()
            expect((await storageOf(pmr).getAlarm())!).toBeLessThanOrEqual(Date.now() + 2_000)
            await storageOf(pmr).deleteAlarm()
            await pmr.alarm()
            expect(await storageOf(pmr).get("reqSweepCursor")).toBeUndefined()
            expect([...(await storageOf(pmr).list({ prefix: "req:" })).keys()]).toEqual([])
            expect(await reqBytes(pmr)).toBe(0)
        })
    })
})
