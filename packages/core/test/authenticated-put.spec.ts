import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodePairPutEnvelope } from "../src/cose/sign1"
import { handlePairPut } from "../src/pair-put"
import type { Admission, AdmissionSource } from "../src/admission"
import { ingestAuthenticatedPut, type AuthenticatedPut } from "../src/authenticated-put"
import type { PMRConfig } from "../src/config"
import type { MessageRef, PMRStore, ReceiveResult } from "../src/storage"

const SENDER = "did:plc:sender000000000000000000" as AuthenticatedPut["senderDID"]
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const NOW = 1_000
const CONFIG = {
    limits: { messageMaxBytes: 100, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig
const PAYLOAD = new TextEncoder().encode("sealed")
const STUB_VERDICT: Admission = { verdict: "no", why: ["stub"] }
const REPLAY = new Uint8Array([1, 2, 3])

function world(opts: {
    receive?: ReceiveResult
    withAdmission?: boolean
    hasMailbox?: boolean
    recipientKnown?: boolean
    appendResult?: unknown
} = {}) {
    const events: string[] = []
    const stored: Array<{ via: string; key: string; ref: MessageRef; replay: Uint8Array }> = []
    const bodies: string[] = []
    const lookups: string[] = []
    const admissionPassed: Admission[] = []
    const admissionAsked: Array<[string, string]> = []
    const bodyWrites: Array<[string, number]> = []
    const storeLocators: unknown[] = []
    const deferred: Promise<unknown>[] = []
    const store = {
        receive: async (key: string, ref: MessageRef, replay: Uint8Array, _now: number, verdict: Admission) => {
            admissionPassed.push(verdict)
            stored.push({ via: "receive", key, ref, replay })
            return opts.receive ?? { outcome: "queued", persistBody: true }
        },
        hasMailbox: async () => opts.hasMailbox ?? true,
        append: async (key: string, ref: MessageRef, replay: Uint8Array) => {
            stored.push({ via: "append", key, ref, replay })
            return opts.appendResult ?? { outcome: "appended", persistBody: true }
        },
        appendToPool: async (key: string, ref: MessageRef, replay: Uint8Array) => {
            stored.push({ via: "pool", key, ref, replay })
            return { outcome: "pooled", persistBody: true }
        },
        deliverLive: async () => void events.push("live"),
        deliverPush: async () => void events.push("push"),
    } as unknown as PMRStore
    const admission: AdmissionSource | undefined = opts.withAdmission
        ? {
              admission: async (sender: string, recipient: string): Promise<Admission> => {
                  admissionAsked.push([sender, recipient])
                  return STUB_VERDICT
              },
          }
        : undefined
    const deps = {
        config: CONFIG,
        directory: {
            resolve: async (did: string) => {
                lookups.push(did)
                return opts.recipientKnown === false ? null : "loc-dir"
            },
        } as never,
        store: (locator: unknown) => {
            storeLocators.push(locator)
            return store
        },
        bodies: {
            putBody: async (id: string, _bytes: Uint8Array, expiresAt: number) =>
                void (bodies.push(id), bodyWrites.push([id, expiresAt]), events.push("body")),
        } as never,
        admission,
        defer: (work: Promise<unknown>) => void deferred.push(work),
    }
    return { deps, admissionPassed, admissionAsked, bodyWrites, stored, bodies, lookups, storeLocators, events, settle: () => Promise.all(deferred), deferredCount: () => deferred.length }
}

function put(overrides: Partial<AuthenticatedPut> = {}): AuthenticatedPut {
    return {
        recipientDID: RECIPIENT,
        senderDID: SENDER,
        declarationCID: DC,
        payload: PAYLOAD,
        replayKey: REPLAY,
        ...overrides,
    }
}

describe("ingestAuthenticatedPut", () => {
    it("an unregistered recipient is noRecipient and touches no store", async () => {
        const w = world({ recipientKnown: false })
        expect(await ingestAuthenticatedPut(put(), w.deps, NOW)).toEqual({ outcome: "noRecipient" })
        expect(w.lookups).toEqual([RECIPIENT])
        expect(w.storeLocators).toEqual([])
        expect(w.stored).toEqual([])
    })

    it("a given locator is stored into without consulting the directory", async () => {
        const w = world({ recipientKnown: false })
        const result = await ingestAuthenticatedPut(put({ locator: "given" as never }), w.deps, NOW)
        expect(result).toEqual({ outcome: "accepted" })
        expect(w.lookups).toEqual([])
        expect(w.storeLocators).toEqual(["given"])
        expect(w.stored).toHaveLength(1)
    })

    it("a payload over messageMaxBytes is tooLarge and stores nothing", async () => {
        const w = world()
        const result = await ingestAuthenticatedPut(
            put({ payload: new Uint8Array(101) }),
            w.deps,
            NOW
        )
        expect(result).toEqual({ outcome: "tooLarge" })
        expect(w.lookups).toEqual([])
        expect(w.stored).toEqual([])
        const exact = await ingestAuthenticatedPut(put({ payload: new Uint8Array(100) }), w.deps, NOW)
        expect(exact).toEqual({ outcome: "accepted" })
    })

    it("with admission, a queued put stores the body and delivers live and by push after the response", async () => {
        const w = world({ withAdmission: true, receive: { outcome: "queued", persistBody: true } })
        const result = await ingestAuthenticatedPut(put(), w.deps, NOW)
        expect(result).toEqual({ outcome: "accepted" })
        expect(w.deferredCount()).toBe(1)
        await w.settle()
        expect(w.events).toEqual(["body", "live", "push"])
        expect(w.admissionAsked).toEqual([[SENDER, RECIPIENT]])
        expect(w.admissionPassed[0]).toBe(STUB_VERDICT)
        expect(w.bodyWrites).toEqual([[w.stored[0]!.ref.messageId, NOW + 1000]])
    })

    it("with admission, a pooled put stores the body; a blocked sender's put stores no body", async () => {
        const pooled = world({ withAdmission: true, receive: { outcome: "pooled", persistBody: true } })
        await ingestAuthenticatedPut(put(), pooled.deps, NOW)
        await pooled.settle()
        expect(pooled.events).toEqual(["body"])

        for (const receive of [
            { outcome: "queued", persistBody: false },
            { outcome: "pooled", persistBody: false },
        ] as const) {
            const blocked = world({ withAdmission: true, receive })
            expect(await ingestAuthenticatedPut(put(), blocked.deps, NOW)).toEqual({
                outcome: "accepted",
            })
            await blocked.settle()
            expect(blocked.bodies).toEqual([])
        }

        const absorbed = world({ appendResult: { outcome: "appended", persistBody: false } })
        await ingestAuthenticatedPut(put(), absorbed.deps, NOW)
        await absorbed.settle()
        expect(absorbed.bodies).toEqual([])
        expect(absorbed.events).toEqual([])
    })

    it("a full reservation is refused with the store's absolute retryAfter", async () => {
        for (const withAdmission of [true, false]) {
            const w = world({
                withAdmission,
                receive: { outcome: "refused", retryAfter: 1_234 },
                appendResult: { outcome: "refused", retryAfter: 1_234 },
            })
            const result = await ingestAuthenticatedPut(put(), w.deps, NOW)
            expect(result).toEqual({ outcome: "refused", retryAfter: 1_234 })
            await w.settle()
            expect(w.bodies).toEqual([])
        }
    })

    it("a repeat of a replayKey while its record lives is accepted and stores nothing new", async () => {
        const w = world({ withAdmission: true, receive: { outcome: "duplicate" } })
        expect(await ingestAuthenticatedPut(put(), w.deps, NOW)).toEqual({ outcome: "accepted" })
        await w.settle()
        expect(w.bodies).toEqual([])
        expect(w.stored[0]!.replay).toEqual(REPLAY)

        const exhausted = world({ withAdmission: true, receive: { outcome: "exhausted" } })
        expect(await ingestAuthenticatedPut(put(), exhausted.deps, NOW)).toEqual({
            outcome: "accepted",
        })
        await exhausted.settle()
        expect(exhausted.bodies).toEqual([])
    })

    it("without admission, a provisioned mailbox appends and an unprovisioned sender pools", async () => {
        const provisioned = world({ hasMailbox: true })
        await ingestAuthenticatedPut(put(), provisioned.deps, NOW)
        await provisioned.settle()
        expect(provisioned.stored.map((s) => s.via)).toEqual(["append"])
        expect(provisioned.stored[0]!.replay).toEqual(REPLAY)
        expect(provisioned.events).toEqual(["body", "live", "push"])

        const unprovisioned = world({ hasMailbox: false })
        await ingestAuthenticatedPut(put(), unprovisioned.deps, NOW)
        await unprovisioned.settle()
        expect(unprovisioned.stored.map((s) => s.via)).toEqual(["pool"])
        expect(unprovisioned.stored[0]!.replay).toEqual(REPLAY)
        expect(unprovisioned.events).toEqual(["body"])
    })

    it("ext and the hint (senderDID, declarationCID) are stored on the ref", async () => {
        for (const opts of [{ withAdmission: true }, { hasMailbox: true }, { hasMailbox: false }]) {
            const w = world(opts)
            await ingestAuthenticatedPut(put({ ext: { flag: true } }), w.deps, NOW)
            const ref = w.stored[0]!.ref
            expect(ref.hint).toEqual({ senderDID: SENDER, declarationCID: DC })
            expect(ref.ext).toEqual({ flag: true })
            expect(w.stored[0]!.key).toBe(SENDER)
            expect(ref.byteLength).toBe(PAYLOAD.byteLength)
        }
        const plain = world()
        await ingestAuthenticatedPut(put(), plain.deps, NOW)
        expect("ext" in plain.stored[0]!.ref).toBe(false)
    })

    it("an ext with a reserved key throws before anything is stored", async () => {
        for (const key of ["k", "id", "m", "sd", "dc", "t"]) {
            const w = world()
            await expect(
                ingestAuthenticatedPut(put({ ext: { [key]: "x" } }), w.deps, NOW)
            ).rejects.toThrow(/reserved/)
            expect(w.lookups).toEqual([])
            expect(w.stored).toEqual([])
        }
    })
})

describe("replayKey", () => {
    it("an empty replayKey throws before anything is stored", async () => {
        const w = world()
        await expect(
            ingestAuthenticatedPut(put({ replayKey: new Uint8Array(0) }), w.deps, NOW)
        ).rejects.toThrow(/replayKey/)
        expect(w.lookups).toEqual([])
        expect(w.stored).toEqual([])
    })
})

describe("ext numbers", () => {
    it("a number that is not a safe integer throws before anything is stored", async () => {
        for (const bad of [1.5, NaN, 2 ** 60]) {
            const w = world()
            await expect(
                ingestAuthenticatedPut(put({ ext: { n: bad } }), w.deps, NOW)
            ).rejects.toThrow(/safe integer/)
            expect(w.stored).toEqual([])
        }
    })
})

describe("handlePairPut over ingestAuthenticatedPut", () => {
    const secretKey = ed25519.utils.randomSecretKey()
    const request = (payload: Uint8Array) =>
        new Request("https://relay.example/pmr/v1/inbox/x/messages", {
            method: "POST",
            body: encodePairPutEnvelope(
                {
                    senderDID: SENDER,
                    recipientDID: RECIPIENT,
                    kid: new Uint8Array(32).fill(0xaa),
                    nonce: new Uint8Array(16).fill(1),
                    payload,
                },
                (message) => ed25519.sign(message, secretKey)
            ),
        })
    const pairDeps = (w: ReturnType<typeof world>) => ({
        ...w.deps,
        resolveDeclaration: async () => ({
            found: true as const,
            anchorKey: { x: ed25519.getPublicKey(secretKey) },
            declarationCID: DC,
        }),
    })

    it("responses are byte-identical to before for 202, 429 + Retry-After and 413", async () => {
        const ok = world()
        const accepted = await handlePairPut(request(PAYLOAD), RECIPIENT, pairDeps(ok), NOW)
        expect(accepted.status).toBe(202)
        expect(await accepted.text()).toBe("")
        expect(ok.stored[0]!.replay).toEqual(new Uint8Array(16).fill(1))
        expect(ok.stored[0]!.ref.hint).toEqual({ senderDID: SENDER, declarationCID: DC })

        const unknown = world({ recipientKnown: false })
        const absent = await handlePairPut(request(PAYLOAD), RECIPIENT, pairDeps(unknown), NOW)
        expect(absent.status).toBe(202)
        expect(unknown.stored).toEqual([])

        const full = world({ appendResult: { outcome: "refused", retryAfter: NOW + 30 } })
        const refused = await handlePairPut(request(PAYLOAD), RECIPIENT, pairDeps(full), NOW)
        expect(refused.status).toBe(429)
        expect(refused.headers.get("Retry-After")).toBe("30")
        const past = world({ appendResult: { outcome: "refused", retryAfter: NOW - 5 } })
        expect(
            (await handlePairPut(request(PAYLOAD), RECIPIENT, pairDeps(past), NOW)).headers.get(
                "Retry-After"
            )
        ).toBe("0")

        const big = world()
        const tooBig = await handlePairPut(request(new Uint8Array(101)), RECIPIENT, pairDeps(big), NOW)
        expect(tooBig.status).toBe(413)
        expect(big.stored).toEqual([])

        // The size check sits above the declaration check.
        const unresolved = world()
        const ordered = await handlePairPut(
            request(new Uint8Array(101)),
            RECIPIENT,
            { ...unresolved.deps, resolveDeclaration: async () => ({ found: false as const, reason: "none" }) },
            NOW
        )
        expect(ordered.status).toBe(413)
    })
})
