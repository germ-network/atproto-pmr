/**
 * `onIntakeStored`: fires once per real stored intake, after the body write,
 * and can never change an outcome or delay delivery.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ingestAuthenticatedPut, type AuthenticatedPut } from "../src/authenticated-put"
import type { PMRConfig } from "../src/config"
import { encodeCose } from "../src/cose/cbor"
import { computeGrantPutTag } from "../src/grant"
import { handleGrantPut } from "../src/grant-put"
import { admitToHold, releaseHeld, type ReleaseDeps } from "../src/sender-hold"
import type { MessageRef, PMRStore } from "../src/storage"
import {
    SENDER_KEY,
    REV,
    heldPut,
    keyPair,
    memoryStorage,
    resolution,
    settledDeclaration,
} from "./fixtures/sender-hold"

const CONFIG = {
    limits: { messageMaxBytes: 100, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig
const NOW = 1_234
const SENDER = "did:plc:sender000000000000000000" as AuthenticatedPut["senderDID"]
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const PAYLOAD = new TextEncoder().encode("sealed")

interface Script {
    append?: unknown
    receive?: unknown
    appendToRequest?: unknown
    appendPair?: unknown
    hasMailbox?: boolean
    admission?: boolean
    recipientKnown?: boolean
    putBody?: () => Promise<void>
    hook?: (at: number) => Promise<unknown> | void
}

function world(script: Script = {}) {
    const events: string[] = []
    const hookCalls: number[] = []
    const deferred: Promise<unknown>[] = []
    const store = {
        hasMailbox: async () => script.hasMailbox ?? true,
        append: async () => script.append ?? { outcome: "appended", persistBody: true },
        receive: async () => script.receive ?? { outcome: "queued", persistBody: true },
        appendToRequest: async () => script.appendToRequest ?? { outcome: "held" },
        appendPair: async (_k: string, ref: MessageRef, _r: Uint8Array, _n: number, evidence: { declarationCID: string }) => {
            const spec = (script.appendPair ?? { result: { outcome: "appended", persistBody: true } }) as {
                result?: unknown
                rejected?: unknown
            }
            return {
                ...spec,
                generation: "g",
                evidenceCID: evidence.declarationCID,
                recycledMessageIds: [],
            }
        },
        deliverLive: async () => void events.push("live"),
        deliverPush: async () => void events.push("push"),
    } as unknown as PMRStore
    const deps = {
        config: CONFIG,
        directory: { resolve: async () => (script.recipientKnown === false ? null : "loc") } as never,
        store: () => store,
        bodies: {
            putBody: async () => {
                await script.putBody?.()
                events.push("body")
            },
            getBody: async () => null,
            deleteBody: async () => {},
        } as never,
        admission: script.admission ? ({ admission: async () => ({ verdict: "no", why: [] }) } as never) : undefined,
        defer: (work: Promise<unknown>) => void deferred.push(work),
        onIntakeStored: (at: number) => {
            hookCalls.push(at)
            events.push("hook")
            return script.hook?.(at)
        },
    }
    const settle = async () => {
        const settled = await Promise.allSettled(deferred)
        expect(settled.filter((r) => r.status === "rejected" && script.putBody === undefined)).toEqual([])
        return settled
    }
    return { deps, events, hookCalls, settle }
}

const put = (overrides: Partial<AuthenticatedPut> = {}): AuthenticatedPut => ({
    recipientDID: RECIPIENT,
    senderDID: SENDER,
    declarationCID: DC,
    payload: PAYLOAD,
    replayKey: new Uint8Array([1]),
    ...overrides,
})
const withEvidence = (): Partial<AuthenticatedPut> =>
    ({ evidence: { declarationCID: DC, revision: "1" } }) as unknown as Partial<AuthenticatedPut>

async function run(script: Script, overrides: Partial<AuthenticatedPut> = {}) {
    const w = world(script)
    const outcome = await ingestAuthenticatedPut(put(overrides), w.deps, NOW)
    await w.settle()
    return { ...w, outcome }
}

let consoleSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {})
    )
})
afterEach(() => vi.restoreAllMocks())
const consoleOutput = () => consoleSpies.flatMap((s) => s.mock.calls)

describe("onIntakeStored fires once", () => {
    it("request-held", async () => {
        const r = await run({ hasMailbox: false, appendToRequest: { outcome: "held" } })
        expect(r.hookCalls).toHaveLength(1)
        expect(r.events.indexOf("body")).toBeLessThan(r.events.indexOf("hook"))
    })

    it("admission-queued", async () => {
        const r = await run({ admission: true, receive: { outcome: "queued", persistBody: true } })
        expect(r.hookCalls).toHaveLength(1)
    })

    it("admission-held", async () => {
        const r = await run({ admission: true, receive: { outcome: "held" } })
        expect(r.hookCalls).toHaveLength(1)
    })

    it("mailbox-appended", async () => {
        const r = await run({ append: { outcome: "appended", persistBody: true } })
        expect(r.hookCalls).toHaveLength(1)
    })

    it("pair-evidence held, appended and queued", async () => {
        for (const result of [
            { outcome: "held" },
            { outcome: "appended", persistBody: true },
            { outcome: "queued", persistBody: true },
        ]) {
            const r = await run({ appendPair: { result } }, withEvidence())
            expect(r.hookCalls, JSON.stringify(result)).toHaveLength(1)
        }
    })

    it("grant appended", async () => {
        const g = grantWorld({})
        expect((await g.send()).status).toBe(202)
        await g.settle()
        expect(g.hookCalls).toEqual([NOW])
    })

    it("sender-hold: at release, never at admit", async () => {
        const hookCalls: number[] = []
        await releaseOneHeld((at) => void hookCalls.push(at), hookCalls)
        expect(hookCalls).toEqual([NOW])
    })

    it("with acceptedAtS equal to the put's nowSeconds", async () => {
        const r = await run({})
        expect(r.hookCalls).toEqual([NOW])
    })
})

describe("onIntakeStored does not fire", () => {
    it("synthetic persistBody:false", async () => {
        expect((await run({ append: { outcome: "appended", persistBody: false } })).hookCalls).toEqual([])
        expect((await run({ admission: true, receive: { outcome: "queued", persistBody: false } })).hookCalls).toEqual([])
        expect(
            (await run({ appendPair: { result: { outcome: "appended", persistBody: false } } }, withEvidence())).hookCalls
        ).toEqual([])
    })

    it("duplicate / replay", async () => {
        expect((await run({ append: { outcome: "duplicate" } })).hookCalls).toEqual([])
        expect((await run({ admission: true, receive: { outcome: "duplicate" } })).hookCalls).toEqual([])
        expect((await run({ appendPair: { result: { outcome: "duplicate" } } }, withEvidence())).hookCalls).toEqual([])
    })

    it("dropped", async () => {
        expect((await run({ admission: true, receive: { outcome: "dropped" } })).hookCalls).toEqual([])
        expect((await run({ appendPair: { result: { outcome: "dropped" } } }, withEvidence())).hookCalls).toEqual([])
    })

    it("refused, tooLarge, noRecipient, unverifiable", async () => {
        const refused = await run({ append: { outcome: "refused", retryAfter: 5 } })
        expect(refused.outcome).toEqual({ outcome: "refused", retryAfter: 5 })
        const tooLarge = await run({}, { payload: new Uint8Array(101) })
        expect(tooLarge.outcome).toEqual({ outcome: "tooLarge" })
        const noRecipient = await run({ recipientKnown: false })
        expect(noRecipient.outcome).toEqual({ outcome: "noRecipient" })
        const unverifiable = await run({ appendPair: { rejected: "stale" } }, withEvidence())
        expect(unverifiable.outcome).toEqual({ outcome: "unverifiable" })
        for (const r of [refused, tooLarge, noRecipient, unverifiable]) expect(r.hookCalls).toEqual([])
    })

    it("grant with a bad tag, a closed address or an unknown address", async () => {
        for (const opts of [{ badTag: true }, { closed: true }, { unknown: true }]) {
            const g = grantWorld(opts)
            expect((await g.send()).status).toBe(202)
            await g.settle()
            expect(g.hookCalls, JSON.stringify(opts)).toEqual([])
        }
    })

    it("grant duplicate or synthetic append", async () => {
        for (const append of [{ outcome: "duplicate" }, { outcome: "appended", persistBody: false }]) {
            const g = grantWorld({ append })
            expect((await g.send()).status).toBe(202)
            await g.settle()
            expect(g.hookCalls, JSON.stringify(append)).toEqual([])
        }
    })

    it("again when a held entry is promoted (moved refs)", async () => {
        const moved = { messageId: "old", byteLength: 1 }
        const r = await run({
            admission: true,
            receive: { outcome: "queued", persistBody: true, moved: [moved] },
        })
        expect(r.hookCalls).toHaveLength(1)
    })

    it("when putBody rejects", async () => {
        const r = await run({
            putBody: async () => {
                throw new Error("kv down")
            },
        })
        expect(r.outcome).toEqual({ outcome: "accepted" })
        expect(r.hookCalls).toEqual([])
    })
})

describe("onIntakeStored failures", () => {
    it("a throwing or rejecting hook leaves outcome, body and live/push delivery unchanged, console silent", async () => {
        const base = await run({})
        for (const hook of [
            () => {
                throw new Error(RECIPIENT)
            },
            () => Promise.reject(new Error(RECIPIENT)),
        ]) {
            const r = await run({ hook })
            expect(r.outcome).toEqual(base.outcome)
            expect(r.events.filter((e) => e !== "hook")).toEqual(base.events.filter((e) => e !== "hook"))
            expect(r.events).toContain("live")
            expect(r.events).toContain("push")
        }
        for (const hook of [
            () => Promise.reject(new Error("x")),
            () => {
                throw new Error("x")
            },
        ]) {
            const g = grantWorld({ hook })
            expect((await g.send()).status).toBe(202)
            await g.settle()
            expect(g.events).toEqual(expect.arrayContaining(["body", "live", "push"]))
        }
        expect(consoleOutput()).toEqual([])
    })

    it("a never-settling or failing hook does not hold up or log from a sender-hold release", async () => {
        const never = await releaseOneHeld(() => new Promise(() => {}), [])
        expect(never.released).toBe(1)
        for (const hook of [() => Promise.reject(new Error("x")), () => { throw new Error("x") }]) {
            expect((await releaseOneHeld(hook, [])).released).toBe(1)
        }
        await Promise.resolve()
        expect(consoleOutput()).toEqual([])
    })

    it("a never-settling hook does not delay live/push delivery", async () => {
        const w = world({ hook: () => new Promise(() => {}) })
        await ingestAuthenticatedPut(put(), w.deps, NOW)
        await vi.waitFor(() => expect(w.events).toEqual(expect.arrayContaining(["live", "push"])))

        const g = grantWorld({ hook: () => new Promise(() => {}) })
        await g.send()
        await vi.waitFor(() => expect(g.events).toEqual(expect.arrayContaining(["live", "push"])))
    })
})

/** Admits one put to the hold (asserting no hook), then releases it. */
async function releaseOneHeld(hook: (at: number) => Promise<unknown> | void, hookCalls: number[]) {
    const key = keyPair()
    const storage = memoryStorage()
    await admitToHold(
        {
            recipientDID: RECIPIENT,
            envelope: heldPut(key.secretKey).envelope,
            snapshotRevision: REV.old,
            nowSeconds: NOW,
        },
        {
            senderDID: SENDER_KEY,
            storage,
            readDirect: async () => resolution(key.publicKey, REV.new),
            maxHeld: 5,
        }
    )
    expect(storage.state.held).toHaveLength(1)
    expect(hookCalls).toEqual([])
    const deps: ReleaseDeps = {
        senderDID: SENDER_KEY,
        storage,
        config: CONFIG,
        directory: { resolve: async (did: string) => did } as never,
        store: () =>
            ({
                appendPair: async (_m: string, _r: unknown, _n: unknown, _t: unknown, evidence: { declarationCID: string }) => ({
                    result: { outcome: "appended", persistBody: true },
                    generation: "g",
                    evidenceCID: evidence.declarationCID,
                    recycledMessageIds: [],
                }),
                deliverLive: async () => {},
                deliverPush: async () => {},
            }) as never,
        bodies: { putBody: async () => {}, deleteBody: async () => {} } as never,
        defer: () => {},
        onIntakeStored: hook,
    }
    return releaseHeld(settledDeclaration(key.publicKey, REV.new), deps, NOW)
}

function grantWorld(opts: {
    badTag?: boolean
    closed?: boolean
    unknown?: boolean
    append?: unknown
    hook?: () => Promise<unknown> | void
}) {
    const authKey = new Uint8Array(32).fill(7)
    const address = "addr-hook"
    const events: string[] = []
    const hookCalls: number[] = []
    const deferred: Promise<unknown>[] = []
    const nonce = `${address}|n`
    const tag = computeGrantPutTag(
        authKey,
        address,
        new TextEncoder().encode(nonce),
        sha256(opts.badTag ? new TextEncoder().encode("other") : PAYLOAD)
    )
    const body = encodeCose(new Map<string, unknown>([["n", nonce], ["t", tag], ["m", PAYLOAD]]) as never)
    const deps = {
        config: CONFIG,
        directory: {
            resolveAddress: async () =>
                opts.unknown ? null : { locator: "loc", closed: opts.closed === true, authKey },
        } as never,
        store: () =>
            ({
                append: async () => opts.append ?? { outcome: "appended", persistBody: true },
                deliverLive: async () => void events.push("live"),
                deliverPush: async () => void events.push("push"),
            }) as unknown as PMRStore,
        bodies: { putBody: async () => void events.push("body") } as never,
        challenges: { mint: async () => {}, consume: async (c: string) => `grantPut:${c.split("|")[0]}` },
        defer: (work: Promise<unknown>) => void deferred.push(work),
        onIntakeStored: (at: number) => {
            hookCalls.push(at)
            return opts.hook?.()
        },
    }
    return {
        events,
        hookCalls,
        send: () => handleGrantPut(new Request("https://relay.test/", { method: "POST", body }), address, deps, NOW),
        settle: async () => {
            const settled = await Promise.allSettled(deferred)
            expect(settled.filter((r) => r.status === "rejected")).toEqual([])
            return settled
        },
    }
}
