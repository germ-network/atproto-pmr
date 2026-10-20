/**
 * A pair put is judged by the recipient's receive-time admission and routed by
 * the store in one step, so devices receive what the recipient's policy admits
 * and judge the rest from the pool. Every outcome keeps the 202/429 vocabulary.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ADMISSION_DEADLINE_MS, ADMISSION_UNAVAILABLE, type Admission, type AdmissionSource } from "../src/admission"
import type { PMRConfig } from "../src/config"
import { encodePairPutEnvelope } from "../src/cose/sign1"
import type { SenderDeclarationResolution } from "../src/declaration"
import { handlePairPut, type PairPutDeps } from "../src/pair-put"
import type { MessageRef, PMRStore, ReceiveResult } from "../src/storage"

const SENDER = "did:plc:sender000000000000000000"
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const NOW = 1_000
const CONFIG = {
    limits: { messageMaxBytes: 10_000, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig

function keyPair() {
    const secretKey = ed25519.utils.randomSecretKey()
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

function put(secretKey: Uint8Array, recipientDID = RECIPIENT, payload = "sealed") {
    const body = encodePairPutEnvelope(
        {
            senderDID: SENDER,
            recipientDID,
            kid: new Uint8Array(32).fill(0xaa),
            nonce: new Uint8Array(16).fill(1),
            payload: new TextEncoder().encode(payload),
        },
        (message) => ed25519.sign(message, secretKey)
    )
    return new Request("https://relay.example/pmr/v1/inbox/x/messages", { method: "POST", body })
}

function world(opts: {
    result?: ReceiveResult
    admission?: AdmissionSource
    resolution?: (did: string) => SenderDeclarationResolution
    publicKey: Uint8Array
    withoutSource?: boolean
    hasMailbox?: boolean
}) {
    const events: string[] = []
    const received: Array<{ key: string; ref: MessageRef; admission: Admission }> = []
    const reads: Array<[string, string]> = []
    const poolVerdicts: unknown[] = []
    const bodies = new Map<string, Uint8Array>()
    let recipientKnown = true
    const store = {
        receive: async (key: string, ref: MessageRef, _n: unknown, _now: number, admission: Admission) => {
            received.push({ key, ref, admission })
            return opts.result ?? { outcome: "pooled", persistBody: true }
        },
        hasMailbox: async () => opts.hasMailbox ?? true,
        unblock: async () => void events.push("unblock"),
        append: async () => {
            events.push("append")
            return { outcome: "appended", persistBody: true }
        },
        appendToPool: async (_k: string, _r: MessageRef, _n: unknown, _t: number, verdict?: unknown) => {
            poolVerdicts.push(verdict)
            return { outcome: "pooled", persistBody: true }
        },
        deliverLive: async (_k: string, ref: MessageRef) => void events.push(`live:${ref.messageId}`),
        deliverPush: async (_k: string, ref: MessageRef) => void events.push(`push:${ref.messageId}`),
    } as unknown as PMRStore
    const source: AdmissionSource | undefined = opts.withoutSource
        ? undefined
        : (opts.admission ?? {
              admission: async (s, r) => {
                  reads.push([s, r])
                  return { verdict: "yes" }
              },
          })
    const deferred: Promise<unknown>[] = []
    const deps: PairPutDeps = {
        config: CONFIG,
        directory: { resolve: async () => (recipientKnown ? ({ id: "r" } as never) : null) } as never,
        store: () => store,
        bodies: {
            putBody: async (id: string, bytes: Uint8Array) => {
                bodies.set(id, bytes)
                events.push(`body:${id}`)
            },
            getBody: async (id: string) => bodies.get(id) ?? null,
        } as never,
        resolveDeclaration:
            opts.resolution ??
            (() => ({ found: true, anchorKey: { x: opts.publicKey }, declarationCID: DC })),
        ...(source ? { admission: source } : {}),
        defer: (work) => void deferred.push(work),
    }
    return {
        deps,
        events,
        received,
        reads,
        poolVerdicts,
        bodies,
        settle: () => Promise.all(deferred),
        setRecipientKnown: (known: boolean) => void (recipientKnown = known),
    }
}

afterEach(() => vi.useRealTimers())

describe("handlePairPut with admission", () => {
    it("reads admission once, as (signed sender, recipient), and passes it to a single store.receive", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey })
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.reads).toEqual([[SENDER, RECIPIENT]])
        expect(w.received).toHaveLength(1)
        expect(w.received[0]!.key).toBe(SENDER)
        expect(w.received[0]!.admission).toEqual({ verdict: "yes" })
        expect(w.events).not.toContain("append")
        expect(w.poolVerdicts).toEqual([])
    })

    it("does not read admission for a 400, 413, 409, wrong-recipient or unknown-recipient put", async () => {
        const { secretKey, publicKey } = keyPair()
        const cases: Array<[number, () => Promise<Response>, ReturnType<typeof world>]> = []
        const w400 = world({ publicKey })
        cases.push([400, () => handlePairPut(new Request("https://x/", { method: "POST", body: new Uint8Array([1, 2, 3]) }), RECIPIENT, w400.deps, NOW), w400])
        const w413 = world({ publicKey })
        cases.push([413, () => handlePairPut(put(secretKey, RECIPIENT, "x".repeat(11_000)), RECIPIENT, w413.deps, NOW), w413])
        const w409 = world({ publicKey, resolution: () => ({ found: false, reason: "none" }) })
        cases.push([409, () => handlePairPut(put(secretKey), RECIPIENT, w409.deps, NOW), w409])
        const wWrong = world({ publicKey })
        cases.push([202, () => handlePairPut(put(secretKey, "did:plc:someoneelse0000000000000"), RECIPIENT, wWrong.deps, NOW), wWrong])
        const wUnknown = world({ publicKey })
        wUnknown.setRecipientKnown(false)
        cases.push([202, () => handlePairPut(put(secretKey), RECIPIENT, wUnknown.deps, NOW), wUnknown])
        for (const [status, run, w] of cases) {
            expect((await run()).status).toBe(status)
            await w.settle()
            expect(w.reads).toEqual([])
            expect(w.received).toEqual([])
        }
    })

    it("a queued outcome with persistBody stores the body, then delivers live and by push", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey, result: { outcome: "queued", persistBody: true } })
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        const id = w.received[0]!.ref.messageId
        expect(w.events).toEqual([`body:${id}`, `live:${id}`, `push:${id}`])
    })

    it("a queued outcome's moved entries are delivered live before the new message, with one push in all", async () => {
        const { secretKey, publicKey } = keyPair()
        const moved: MessageRef[] = [
            { messageId: "m1" as never, byteLength: 1 },
            { messageId: "m2" as never, byteLength: 1 },
        ]
        const w = world({ publicKey, result: { outcome: "queued", persistBody: true, moved } })
        w.bodies.set("m1", new Uint8Array([1]))
        w.bodies.set("m2", new Uint8Array([2]))
        await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        const id = w.received[0]!.ref.messageId
        expect(w.events.filter((e) => !e.startsWith("body:m"))).toEqual([
            `body:${id}`,
            "live:m1",
            "live:m2",
            `live:${id}`,
            `push:${id}`,
        ])
        expect(w.events.filter((e) => e.startsWith("push:"))).toHaveLength(1)
    })

    it("a queued outcome without persistBody stores and delivers nothing", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey, result: { outcome: "queued", persistBody: false } })
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.events).toEqual([])
    })

    it("a yes admission is passed to the store unchanged and the put path never unblocks the sender", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey, result: { outcome: "queued", persistBody: false } })
        expect((await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)).status).toBe(202)
        await w.settle()
        expect(w.received.map((r) => r.admission)).toEqual([{ verdict: "yes" }])
        expect(w.events).toEqual([])
    })

    it("a pooled outcome with persistBody stores the body and delivers nothing", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey, result: { outcome: "pooled", persistBody: true } })
        await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        const id = w.received[0]!.ref.messageId
        expect(w.events).toEqual([`body:${id}`])
        const dropped = world({ publicKey, result: { outcome: "pooled", persistBody: false } })
        await handlePairPut(put(secretKey), RECIPIENT, dropped.deps, NOW)
        await dropped.settle()
        expect(dropped.events).toEqual([])
    })

    it("refused answers 429 with Retry-After; queued, pooled, duplicate and exhausted answer 202", async () => {
        const { secretKey, publicKey } = keyPair()
        const refused = world({ publicKey, result: { outcome: "refused", retryAfter: NOW + 30 } })
        const r = await handlePairPut(put(secretKey), RECIPIENT, refused.deps, NOW)
        await refused.settle()
        expect(r.status).toBe(429)
        expect(r.headers.get("Retry-After")).toBe("30")
        expect(refused.events).toEqual([])
        for (const result of [
            { outcome: "queued", persistBody: true },
            { outcome: "pooled", persistBody: true },
            { outcome: "duplicate" },
            { outcome: "exhausted" },
        ] as ReceiveResult[]) {
            const w = world({ publicKey, result })
            expect((await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)).status).toBe(202)
            await w.settle()
        }
    })

    it("a throwing or slow admission source passes unknown with admission-unavailable and never answers 5xx", async () => {
        const { secretKey, publicKey } = keyPair()
        const throwing = world({ publicKey, admission: { admission: async () => Promise.reject(new Error("d1")) } })
        expect((await handlePairPut(put(secretKey), RECIPIENT, throwing.deps, NOW)).status).toBe(202)
        expect(throwing.received[0]!.admission).toEqual({ verdict: "unknown", why: [ADMISSION_UNAVAILABLE] })

        vi.useFakeTimers()
        const slow = world({ publicKey, admission: { admission: () => new Promise(() => {}) } })
        const pending = handlePairPut(put(secretKey), RECIPIENT, slow.deps, NOW)
        await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS)
        expect((await pending).status).toBe(202)
        expect(slow.received[0]!.admission).toEqual({ verdict: "unknown", why: [ADMISSION_UNAVAILABLE] })
    })

    it("a failing delivery of a moved entry does not stop later deliveries or the push", async () => {
        const { secretKey, publicKey } = keyPair()
        const moved: MessageRef[] = [
            { messageId: "m1" as never, byteLength: 1 },
            { messageId: "m2" as never, byteLength: 1 },
        ]
        const w = world({ publicKey, result: { outcome: "queued", persistBody: true, moved } })
        w.bodies.set("m2", new Uint8Array([2]))
        const getBody = w.deps.bodies.getBody
        w.deps.bodies.getBody = async (id) => {
            if (id === "m1") throw new Error("kv")
            return getBody(id)
        }
        await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        const id = w.received[0]!.ref.messageId
        expect(w.events).toEqual(expect.arrayContaining(["live:m2", `live:${id}`, `push:${id}`]))
    })

    it("without an admission source, behaves as before: provisioned appends, everything else pools without a verdict", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world({ publicKey, withoutSource: true })
        await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(w.received).toEqual([])
        expect(w.events[0]).toBe("append")

        const pooled = world({ publicKey, withoutSource: true, hasMailbox: false })
        await handlePairPut(put(secretKey), RECIPIENT, pooled.deps, NOW)
        await pooled.settle()
        expect(pooled.poolVerdicts).toEqual([undefined])
        expect(pooled.events).not.toContain("append")
    })
})
