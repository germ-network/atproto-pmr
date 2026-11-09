/**
 * A put held in a request mailbox stores its body and wakes nothing; one the
 * shared quota drops stores nothing; one the sender's depth refuses answers
 * 429. The put's outcome vocabulary does not change.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import type { Admission, AdmissionSource } from "../src/admission"
import { ingestAuthenticatedPut, type AuthenticatedPut } from "../src/authenticated-put"
import type { PMRConfig } from "../src/config"
import { encodePairPutEnvelope } from "../src/cose/sign1"
import { handlePairPut, type PairPutDeps } from "../src/pair-put"
import type { MessageRef, PMRStore, PairMailboxEvidence, ReceiveResult, RequestAppendResult } from "../src/storage"

const SENDER = "did:plc:sender000000000000000000" as AuthenticatedPut["senderDID"]
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const NOW = 1_000
const CONFIG = {
    limits: { messageMaxBytes: 10_000, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig
const NO: Admission = { verdict: "no", why: ["stub"] }
const EVIDENCE = { declarationCID: DC } as unknown as PairMailboxEvidence

function world(opts: {
    receive?: ReceiveResult
    request?: RequestAppendResult
    hasMailbox?: boolean
    withAdmission?: boolean
    recycleOwnId?: boolean
} = {}) {
    const events: string[] = []
    const calls: string[] = []
    const bodies = new Map<string, Uint8Array>()
    const deferred: Promise<unknown>[] = []
    const store = {
        appendPair: async (
            key: string, ref: MessageRef, nonce: Uint8Array, now: number,
            evidence: { declarationCID: string }, admission?: Admission
        ) => {
            const result = admission !== undefined
                ? await store.receive(key, ref, nonce, now)
                : (await store.hasMailbox())
                    ? await store.append()
                    : await store.appendToRequest(key, ref, nonce, now)
            return {
                result, generation: "generation-1", evidenceCID: evidence.declarationCID,
                generationChanged: true,
                recycledMessageIds: opts.recycleOwnId ? [ref.messageId] : [],
            }
        },
        receive: async () => {
            calls.push("receive")
            return opts.receive ?? { outcome: "held" }
        },
        hasMailbox: async () => opts.hasMailbox ?? true,
        append: async () => {
            calls.push("append")
            return { outcome: "appended", persistBody: true }
        },
        appendToRequest: async () => {
            calls.push("appendToRequest")
            return opts.request ?? { outcome: "held" }
        },
        deliverLive: async (_k: string, ref: MessageRef) => void events.push(`live:${ref.messageId}`),
        deliverPush: async (_k: string, ref: MessageRef) => void events.push(`push:${ref.messageId}`),
    } as unknown as PMRStore
    const admission: AdmissionSource | undefined = opts.withAdmission === false
        ? undefined
        : { admission: async () => NO }
    const deps = {
        config: CONFIG,
        directory: { resolve: async () => "loc" } as never,
        store: () => store,
        bodies: {
            putBody: async (id: string, bytes: Uint8Array) => {
                bodies.set(id, bytes)
                events.push(`body:${id}`)
            },
            getBody: async (id: string) => bodies.get(id) ?? null,
            deleteBody: async (id: string) => void events.push(`delete:${id}`),
        } as never,
        admission,
        defer: (work: Promise<unknown>) => void deferred.push(work),
    }
    return { deps, events, calls, bodies, settle: () => Promise.all(deferred) }
}

function authPut(overrides: Partial<AuthenticatedPut> = {}): AuthenticatedPut {
    return {
        recipientDID: RECIPIENT,
        senderDID: SENDER,
        declarationCID: DC,
        payload: new TextEncoder().encode("sealed"),
        replayKey: new Uint8Array([1, 2, 3]),
        ...overrides,
    }
}

const bodyEvents = (events: string[]) => events.filter((e) => e.startsWith("body:"))

describe("ingestAuthenticatedPut into a request mailbox", () => {
    it("stores the body of a held put and calls neither deliverLive nor deliverPush", async () => {
        const w = world({ receive: { outcome: "held" } })
        expect(await ingestAuthenticatedPut(authPut(), w.deps, NOW)).toEqual({ outcome: "accepted" })
        await w.settle()
        expect(w.events).toHaveLength(1)
        expect(w.events[0]).toMatch(/^body:/)
    })

    it("writes no body for a dropped put and answers accepted", async () => {
        const w = world({ receive: { outcome: "dropped" } })
        expect(await ingestAuthenticatedPut(authPut(), w.deps, NOW)).toEqual({ outcome: "accepted" })
        await w.settle()
        expect(w.events).toEqual([])
    })

    it("answers refused with the store's retryAfter when the request mailbox is full", async () => {
        const viaReceive = world({ receive: { outcome: "refused", retryAfter: 4_321 } })
        expect(await ingestAuthenticatedPut(authPut(), viaReceive.deps, NOW)).toEqual({
            outcome: "refused",
            retryAfter: 4_321,
        })
        const viaRequest = world({ withAdmission: false, hasMailbox: false, request: { outcome: "refused", retryAfter: 4_321 } })
        expect(await ingestAuthenticatedPut(authPut(), viaRequest.deps, NOW)).toEqual({
            outcome: "refused",
            retryAfter: 4_321,
        })
        await viaReceive.settle()
        await viaRequest.settle()
        expect(viaReceive.events).toEqual([])
        expect(viaRequest.events).toEqual([])
    })

    it("holds through appendToRequest on the no-admission path when the store has no mailbox", async () => {
        const w = world({ withAdmission: false, hasMailbox: false })
        expect(await ingestAuthenticatedPut(authPut(), w.deps, NOW)).toEqual({ outcome: "accepted" })
        await w.settle()
        expect(w.calls).toEqual(["appendToRequest"])
        expect(bodyEvents(w.events)).toHaveLength(1)
        expect(w.events).toHaveLength(1)

        const dropped = world({ withAdmission: false, hasMailbox: false, request: { outcome: "dropped" } })
        await ingestAuthenticatedPut(authPut(), dropped.deps, NOW)
        await dropped.settle()
        expect(dropped.events).toEqual([])

        const deep = world({ withAdmission: false, hasMailbox: true })
        await ingestAuthenticatedPut(authPut(), deep.deps, NOW)
        expect(deep.calls).toEqual(["append"])
    })

    it("treats held and dropped from receive and from appendPair alike", async () => {
        for (const evidence of [undefined, EVIDENCE]) {
            const held = world({ receive: { outcome: "held" } })
            expect(await ingestAuthenticatedPut(authPut({ evidence }), held.deps, NOW)).toEqual({ outcome: "accepted" })
            await held.settle()
            expect(held.events).toHaveLength(1)
            expect(held.events[0]).toMatch(/^body:/)

            const dropped = world({ receive: { outcome: "dropped" } })
            expect(await ingestAuthenticatedPut(authPut({ evidence }), dropped.deps, NOW)).toEqual({ outcome: "accepted" })
            await dropped.settle()
            expect(dropped.events).toEqual([])
        }
    })

    it("keeps the body of a held put whose id a key change recycled", async () => {
        const w = world({ receive: { outcome: "held" }, recycleOwnId: true })
        await ingestAuthenticatedPut(authPut({ evidence: EVIDENCE }), w.deps, NOW)
        await w.settle()
        expect(w.events).toHaveLength(1)
        expect(w.events[0]).toMatch(/^body:/)
    })

    it("delivers request entries a yes moved before the admitted put, with one push", async () => {
        const moved: MessageRef[] = [
            { messageId: "m1" as never, byteLength: 1 },
            { messageId: "m2" as never, byteLength: 1 },
        ]
        const w = world({ receive: { outcome: "queued", persistBody: true, moved } })
        w.bodies.set("m1", new Uint8Array([1]))
        w.bodies.set("m2", new Uint8Array([2]))
        await ingestAuthenticatedPut(authPut(), w.deps, NOW)
        await w.settle()
        const live = w.events.filter((e) => e.startsWith("live:"))
        expect(live.slice(0, 2)).toEqual(["live:m1", "live:m2"])
        expect(live).toHaveLength(3)
        expect(w.events.filter((e) => e.startsWith("push:"))).toHaveLength(1)
    })
})

function signed(secretKey: Uint8Array) {
    return new Request("https://relay.example/pmr/v1/inbox/x/messages", {
        method: "POST",
        body: encodePairPutEnvelope(
            {
                senderDID: SENDER,
                recipientDID: RECIPIENT,
                kid: new Uint8Array(32).fill(0xaa),
                nonce: new Uint8Array(16).fill(1),
                payload: new TextEncoder().encode("sealed"),
            },
            (message) => ed25519.sign(message, secretKey)
        ),
    })
}

function pairPutWorld(result: ReceiveResult, publicKey: Uint8Array) {
    const w = world({ receive: result })
    const deps: PairPutDeps = {
        ...w.deps,
        resolveDeclaration: () => ({
            found: true,
            anchorKey: { x: publicKey },
            declarationCID: DC,
            revision: "2222222222222",
            evidenceCAR: new Uint8Array([1]),
        }),
    } as PairPutDeps
    return { ...w, deps }
}

describe("handlePairPut into a request mailbox", () => {
    it("answers 202 for a held put and for a dropped one", async () => {
        const secretKey = ed25519.utils.randomSecretKey()
        const publicKey = ed25519.getPublicKey(secretKey)
        for (const result of [{ outcome: "held" }, { outcome: "dropped" }] as ReceiveResult[]) {
            const w = pairPutWorld(result, publicKey)
            const response = await handlePairPut(signed(secretKey), RECIPIENT, w.deps, NOW)
            await w.settle()
            expect(response.status).toBe(202)
            expect(bodyEvents(w.events)).toHaveLength(result.outcome === "held" ? 1 : 0)
            expect(w.events.filter((e) => !e.startsWith("body:"))).toEqual([])
        }
    })

    it("answers 429 with Retry-After when the sender's request mailbox is full", async () => {
        const secretKey = ed25519.utils.randomSecretKey()
        const w = pairPutWorld({ outcome: "refused", retryAfter: NOW + 45 }, ed25519.getPublicKey(secretKey))
        const response = await handlePairPut(signed(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(429)
        expect(response.headers.get("Retry-After")).toBe("45")
        expect(w.events).toEqual([])
    })
})
