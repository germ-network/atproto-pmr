import vectors from "../../../spec/vectors/registration-bundle.json"
import * as signatures from "../../core/src/http-sig/verify"
import { ed25519 } from "@noble/curves/ed25519.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    decodeCoseMap, encodeBinding, encodeCose, encodeOkpEd25519Key,
    handleRegistrationCreate, signRequest, toResponseBody,
    type ChallengeStore, type CoseValue, type Directory, type PMRStore,
    type RegistrationFields,
} from "@germ-network/atproto-pmr-core"
import { monitorRegistrationHook } from "../src/registration-endpoint"
import type { MonitorRegistration } from "../src/registration"

const DID = "did:plc:bundle"
const URL = "https://relay.example/pmr/v1/registrations"
const map = (fields: Record<string, CoseValue>) => new Map<string, CoseValue>(Object.entries(fields))
const subscription = (id = 2) => map({ pse: `https://push.example/${id}`, psk: new Uint8Array(32).fill(id), psi: id })
const fullBody = () => map({ pse: "https://push.example/mailbox", psk: new Uint8Array(32).fill(1), psi: 1,
    bundle: map({ v: 1, monitor: subscription() }) })

function world() {
    const secret = ed25519.utils.randomSecretKey()
    let declared: Uint8Array = ed25519.getPublicKey(secret)
    let mailbox: RegistrationFields | null = null
    let monitor: MonitorRegistration | null = null
    let seq = 0
    const nonces = new Map<string, string>()
    const challenges: ChallengeStore = {
        mint: async (nonce, bound) => { nonces.set(nonce, bound) },
        consume: vi.fn(async (nonce) => {
            const bound = nonces.get(nonce) ?? null
            nonces.delete(nonce)
            return bound
        }),
    }
    const create = vi.fn(async (_did: string, fields: RegistrationFields) => {
        mailbox ??= fields
        return "locator"
    })
    const update = vi.fn(async (fields: Partial<RegistrationFields>) => {
        mailbox = { ...mailbox!, ...fields }
    })
    const directory = {
        isTombstoned: async () => false,
        resolve: async () => mailbox === null ? null : "locator",
        create,
        delete: vi.fn(async () => { mailbox = null }),
    } as unknown as Directory
    const store = () => ({ load: async () => mailbox, update }) as unknown as PMRStore
    const registrations = {
        load: vi.fn(async () => monitor),
        put: vi.fn(async (row: MonitorRegistration) => { monitor = row }),
        delete: vi.fn(async () => { monitor = null }),
    }
    const resolveAnchorKey = vi.fn(async (_did: string): Promise<Uint8Array | null> => declared)
    const deps = { challenges, directory, store, resolveLocator: directory.resolve,
        resolveAnchorKey, nowSeconds: 100,
        registrationMonitor: monitorRegistrationHook(registrations) }
    async function request(body: Map<string | number, CoseValue> = fullBody(), signer: Uint8Array = secret, subject = DID, tamper?: Uint8Array) {
        const nonce = `nonce-${seq++}`
        await challenges.mint(nonce, encodeBinding({ realm: "anchor", subject }), 1000)
        const bytes = encodeCose(body)
        const signed = signRequest({ method: "POST", url: URL, nonce, keyid: "t", secretKey: signer, body: bytes })
        return new Request(URL, { method: "POST", headers: signed.headers, body: toResponseBody(tamper ?? bytes) })
    }
    async function call(body: Map<string | number, CoseValue> = fullBody()) { return handleRegistrationCreate(await request(body), deps) }
    return { secret, deps, call, request, registrations, create, update, challenges, resolveAnchorKey,
        mailbox: () => mailbox, monitor: () => monitor,
        setDeclared: (key: Uint8Array) => { declared = key },
    }
}

async function receipt(response: Response, outcome: string) {
    expect(response.status).toBe(201)
    const body = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
    expect(body.get("l")).toBe("locator")
    expect(body.get("bundle")).toEqual(map({ v: 1, monitor: outcome }))
}

describe("authenticated mailbox/monitor bundle", () => {
    it("commits both distinct subscriptions with one redemption and declaration resolution", async () => {
        const w = world()
        const verify = vi.spyOn(signatures, "verifyRequestSignature")
        try {
            await receipt(await w.call(), "accepted")
            expect(verify).toHaveBeenCalledTimes(1)
        } finally { verify.mockRestore() }
        expect(w.challenges.consume).toHaveBeenCalledTimes(1)
        expect(w.resolveAnchorKey).toHaveBeenCalledExactlyOnceWith(DID)
        expect(w.mailbox()?.pushSubscription?.keyId).toBe(1)
        expect(w.monitor()?.pushSubscription.keyId).toBe(2)
        expect(w.monitor()?.anchorKey).toEqual(encodeOkpEd25519Key({ x: ed25519.getPublicKey(w.secret) }))
    })

    it("keeps legacy response exact and never touches the monitor", async () => {
        const w = world()
        const response = await w.call(map({}))
        expect(decodeCoseMap(new Uint8Array(await response.arrayBuffer()))).toEqual(map({ l: "locator" }))
        expect(w.registrations.load).not.toHaveBeenCalled()
        expect(w.registrations.put).not.toHaveBeenCalled()
    })

    it("reports unavailable without material or injected capability", async () => {
        const w = world()
        await receipt(await w.call(map({ bundle: map({ v: 1 }) })), "unavailable")
        const { registrationMonitor: _, ...deps } = w.deps
        await receipt(await handleRegistrationCreate(await w.request(), deps), "unavailable")
        expect(w.registrations.load).not.toHaveBeenCalled()
    })

    const badBundles: CoseValue[] = [null, 1, [], map({}), map({ v: 2 }), map({ v: "1" }),
        map({ v: 1, monitor: null }), map({ v: 1, monitor: map({}) }),
        ...["http://push.example", "garbage", 1].map(pse => map({ v: 1, monitor: map({ pse, psk: new Uint8Array(32), psi: 1 }) })),
        ...[new Uint8Array(31), "key", null].map(psk => map({ v: 1, monitor: map({ pse: "https://push.example", psk, psi: 1 }) })),
        ...[-1, 256, "2", null].map(psi => map({ v: 1, monitor: map({ pse: "https://push.example", psk: new Uint8Array(32), psi }) })),
    ]
    it.each(badBundles.map((bundle, i) => ({ bundle, i })))("rejects malformed authenticated bundle $i before either write", async ({ bundle }) => {
        const w = world()
        expect((await w.call(map({ ...Object.fromEntries(fullBody()), bundle }))).status).toBe(400)
        expect(w.create).not.toHaveBeenCalled()
        expect(w.update).not.toHaveBeenCalled()
        expect(w.registrations.load).not.toHaveBeenCalled()
    })

    it("validates before different-key mailbox replacement", async () => {
        const w = world()
        await w.call()
        const prior = w.mailbox()
        const next = ed25519.utils.randomSecretKey()
        w.setDeclared(ed25519.getPublicKey(next))
        const request = await w.request(map({ bundle: map({ v: 99 }) }), next)
        expect((await handleRegistrationCreate(request, w.deps)).status).toBe(400)
        expect(w.mailbox()).toBe(prior)
        expect(w.deps.directory.delete).not.toHaveBeenCalled()
    })

    it.each(["signature", "subject", "body"])("rejects forged %s before service writes", async (attack) => {
        const w = world()
        if (attack === "subject") w.resolveAnchorKey.mockImplementation(async did => did === DID ? ed25519.getPublicKey(w.secret) : ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
        const request = await w.request(fullBody(), attack === "signature" ? ed25519.utils.randomSecretKey() : w.secret,
            attack === "subject" ? "did:plc:other" : DID, attack === "body" ? encodeCose(map({ bundle: map({ v: 1 }) })) : undefined)
        expect((await handleRegistrationCreate(request, w.deps)).status).toBe(401)
        expect(w.create).not.toHaveBeenCalled()
        expect(w.registrations.load).not.toHaveBeenCalled()
    })

    it.each(["create", "update"] as const)("mailbox %s failure skips monitor", async failure => {
        const w = world()
        w[failure].mockRejectedValueOnce(new Error("mailbox offline"))
        await expect(w.call()).rejects.toThrow("mailbox offline")
        expect(w.registrations.load).not.toHaveBeenCalled()
        expect(w.registrations.put).not.toHaveBeenCalled()
    })

    it.each(["load", "put"] as const)("monitor %s failure retains mailbox receipt without diagnosis", async failure => {
        const w = world()
        w.registrations[failure].mockRejectedValueOnce(new Error("secret store diagnosis"))
        await receipt(await w.call(), "unresolved")
        expect(w.mailbox()).not.toBeNull()
    })

    it("does not acknowledge accepted while monitor put is parked", async () => {
        const w = world()
        let release!: () => void
        let entered!: () => void
        const arrived = new Promise<void>(resolve => { entered = resolve })
        w.registrations.put.mockImplementationOnce(async () => {
            entered()
            await new Promise<void>(resolve => { release = resolve })
        })
        let settled = false
        const response = w.call().then(r => { settled = true; return r })
        await arrived
        expect(w.mailbox()).not.toBeNull()
        expect(settled).toBe(false)
        release()
        await receipt(await response, "accepted")
    })

    it("retries stable material after lost receipt, and permits same-key subscription rebind", async () => {
        const w = world()
        await w.call() // Simulate dropping the successful response.
        const prior = w.monitor()
        await receipt(await w.call(), "accepted")
        expect(w.monitor()).toEqual(prior)
        await receipt(await w.call(map({ bundle: map({ v: 1, monitor: subscription(3) }) })), "accepted")
        expect(w.monitor()?.pushSubscription.keyId).toBe(3)
        expect(w.monitor()?.anchorKey).toEqual(prior?.anchorKey)
    })

    it("replaces mailbox under new declared key without replacing the protected monitor", async () => {
        const w = world()
        await w.call()
        const protectedRow = w.monitor()
        const next = ed25519.utils.randomSecretKey()
        w.setDeclared(ed25519.getPublicKey(next))
        await receipt(await handleRegistrationCreate(await w.request(fullBody(), next), w.deps), "unresolved")
        expect(w.mailbox()?.anchorKey).toEqual(encodeOkpEd25519Key({ x: ed25519.getPublicKey(next) }))
        expect(w.monitor()).toBe(protectedRow)
        expect(w.registrations.put).toHaveBeenCalledTimes(1)
        expect(w.registrations.delete).not.toHaveBeenCalled()
    })

    it("treats a malformed stored monitor key as unresolved and never overwrites it", async () => {
        const w = world()
        await w.call()
        w.monitor()!.anchorKey = new Uint8Array(3)
        await receipt(await w.call(), "unresolved")
        expect(w.registrations.put).toHaveBeenCalledTimes(1)
    })
})

// Hex was produced with an independent fixture encoder, not encodeCose.
function unhex(hex: string): Uint8Array {
    return new Uint8Array(hex.match(/../g)!.map(byte => parseInt(byte, 16)))
}
function fromDiagnostic(value: unknown): CoseValue {
    if (typeof value === "string" || typeof value === "number") return value
    const object = value as Record<string, unknown>
    if (typeof object.$hex === "string") return unhex(object.$hex)
    return new Map(Object.entries(object).map(([k, v]) => [k, fromDiagnostic(v)]))
}
describe("published deterministic bundle vectors", () => {
    it.each(vectors.vectors)("round trips $name byte for byte", ({ value, hex }) => {
        const decoded = decodeCoseMap(unhex(hex))
        expect(decoded).toEqual(fromDiagnostic(value))
        expect(new Uint8Array(encodeCose(decoded))).toEqual(unhex(hex))
    })
    it.each(vectors.vectors.filter(v => v.kind === "request"))("executes $name", async ({ name, hex }) => {
        const w = world()
        const response = await w.call(decodeCoseMap(unhex(hex)))
        if (name === "unsupported-version-request") {
            expect(response.status).toBe(400)
            expect(w.create).not.toHaveBeenCalled()
            return
        }
        expect(response.status).toBe(201)
        const responseName = name === "legacy-request" ? "legacy-response" :
            name === "v1-no-monitor-request" ? "v1-unavailable-response" : "v1-accepted-response"
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            unhex(vectors.vectors.find(v => v.name === responseName)!.hex))
    })
})

describe("bundle admission boundaries", () => {
    it("malformed mailbox material prevents an otherwise valid monitor bundle", async () => {
        const w = world()
        const body = fullBody()
        body.set("psk", new Uint8Array(31))
        expect((await w.call(body)).status).toBe(400)
        expect(w.create).not.toHaveBeenCalled()
        expect(w.registrations.load).not.toHaveBeenCalled()
    })
    it("retains the body cap before authentication or service writes", async () => {
        const w = world()
        const body = fullBody()
        body.set("padding", new Uint8Array(16 * 1024))
        expect((await w.call(body)).status).toBe(413)
        expect(w.challenges.consume).not.toHaveBeenCalled()
        expect(w.resolveAnchorKey).not.toHaveBeenCalled()
        expect(w.create).not.toHaveBeenCalled()
        expect(w.registrations.load).not.toHaveBeenCalled()
    })
    it("omitting monitor material leaves an existing subscription untouched", async () => {
        const w = world()
        await w.call()
        const prior = w.monitor()
        w.registrations.load.mockClear()
        w.registrations.put.mockClear()
        await receipt(await w.call(map({ bundle: map({ v: 1 }) })), "unavailable")
        expect(w.monitor()).toBe(prior)
        expect(w.registrations.load).not.toHaveBeenCalled()
        expect(w.registrations.put).not.toHaveBeenCalled()
    })
})


afterEach(() => vi.useRealTimers())

describe("bounded post-mailbox monitor wait", () => {
    function parked(phase: "load" | "put", timeoutMs?: number) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const w = world()
        let release!: () => void
        let fail!: (error: Error) => void
        let entered!: () => void
        let retained!: Promise<void>
        const arrived = new Promise<void>(resolve => { entered = resolve })
        const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
        const originalPut = w.registrations.put.getMockImplementation()!
        if (phase === "load") {
            w.registrations.load.mockImplementationOnce(async () => {
                entered()
                await gate
                return null
            })
        } else {
            w.registrations.put.mockImplementationOnce(async row => {
                entered()
                await gate
                await originalPut(row)
            })
        }
        const deps = { ...w.deps, registrationMonitorTimeoutMs: timeoutMs,
            deferRegistrationMonitor: vi.fn((work: Promise<void>) => { retained = work }) }
        let settled = false
        const response = w.request().then(request => handleRegistrationCreate(request, deps))
            .then(response => { settled = true; return response })
        return { w, deps, arrived, response, release, fail, retained: () => retained, settled: () => settled }
    }

    it("returns the mailbox receipt at the default deadline and retains a late successful put", async () => {
        const p = parked("put")
        await p.arrived
        expect(p.w.mailbox()).not.toBeNull()
        expect(p.deps.deferRegistrationMonitor).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(4_999)
        expect(p.settled()).toBe(false)
        expect(p.w.monitor()).toBeNull()
        await vi.advanceTimersByTimeAsync(1)
        const response = await p.response
        const lateReceipt = response.clone()
        await receipt(response, "unresolved")
        p.release()
        await expect(p.retained()).resolves.toBeUndefined()
        expect(p.w.monitor()?.pushSubscription.keyId).toBe(2)
        await receipt(lateReceipt, "unresolved")
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each(["load", "put"] as const)("bounds a parked monitor %s and handles its late rejection", async phase => {
        const p = parked(phase, 25)
        await p.arrived
        await vi.advanceTimersByTimeAsync(25)
        await receipt(await p.response, "unresolved")
        p.fail(new Error("late private store failure"))
        await expect(p.retained()).resolves.toBeUndefined()
        expect(p.w.mailbox()).not.toBeNull()
        expect(p.w.monitor()).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it("accepts completion inside the configured budget and clears the deadline", async () => {
        const p = parked("put", 25)
        await p.arrived
        await vi.advanceTimersByTimeAsync(24)
        expect(p.settled()).toBe(false)
        p.release()
        await receipt(await p.response, "accepted")
        await expect(p.retained()).resolves.toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each([0, -1, NaN, Infinity, 2_147_483_648])("uses the finite default for invalid budget %s", async timeoutMs => {
        const p = parked("put", timeoutMs)
        await p.arrived
        await vi.advanceTimersByTimeAsync(4_999)
        expect(p.settled()).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await receipt(await p.response, "unresolved")
        p.release()
        await p.retained()
    })

    it("starts the budget after a slow mailbox write completes", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const w = world()
        let release!: () => void
        let entered!: () => void
        const arrived = new Promise<void>(resolve => { entered = resolve })
        const original = w.update.getMockImplementation()!
        w.update.mockImplementationOnce(async fields => {
            entered()
            await new Promise<void>(resolve => { release = resolve })
            await original(fields)
        })
        let settled = false
        const response = w.call().then(response => { settled = true; return response })
        await arrived
        await vi.advanceTimersByTimeAsync(10_000)
        expect(settled).toBe(false)
        expect(w.registrations.load).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
        release()
        await receipt(await response, "accepted")
        expect(vi.getTimerCount()).toBe(0)
    })

    it("a throwing lifetime callback cannot discard a successful mailbox/monitor receipt", async () => {
        const w = world()
        await receipt(await handleRegistrationCreate(await w.request(), {
            ...w.deps,
            deferRegistrationMonitor: () => { throw new Error("host unavailable") },
        }), "accepted")
    })
})
