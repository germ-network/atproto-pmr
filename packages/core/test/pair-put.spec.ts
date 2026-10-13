/**
 * `handlePairPut` admission against the sender's declaration: the hint names
 * the exact declaration verified against, and a put the relay cannot verify
 * yet is a retryable state error that stores nothing.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import type { PMRConfig } from "../src/config"
import { encodePairPutEnvelope } from "../src/cose/sign1"
import type { SenderDeclarationResolution } from "../src/declaration"
import {
    DECLARATION_RETRY_AFTER_SECONDS,
    handlePairPut,
    type PairPutDeps,
} from "../src/pair-put"
import type { MessageRef, PMRStore } from "../src/storage"

const SENDER = "did:plc:sender000000000000000000"
const RECIPIENT = "did:plc:recipient00000000000000000"
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const NOW = 1_000

const CONFIG = {
    limits: {
        messageMaxBytes: 10_000,
        framingAllowanceBytes: 1024,
        messageExpirySeconds: 1000,
    },
} as unknown as PMRConfig

function world(resolution: (did: string) => SenderDeclarationResolution) {
    const appended: Array<{ key: string; ref: MessageRef }> = []
    const bodies: string[] = []
    const lookups: string[] = []
    let hasMailbox = true
    let recipientKnown = true
    const store = {
        hasMailbox: async () => hasMailbox,
        append: async (key: string, ref: MessageRef) => {
            appended.push({ key, ref })
            return { outcome: "appended", persistBody: true }
        },
        appendToPool: async (key: string, ref: MessageRef) => {
            appended.push({ key, ref })
            return { outcome: "pooled", persistBody: true }
        },
    } as unknown as PMRStore
    const deferred: Promise<unknown>[] = []
    const deps: PairPutDeps = {
        config: CONFIG,
        directory: {
            resolve: async (did: string) => {
                lookups.push(did)
                return recipientKnown ? ({ id: "r" } as never) : null
            },
        } as never,
        store: () => store,
        bodies: {
            putBody: async (id: string) => void bodies.push(id),
        } as never,
        resolveDeclaration: async (did) => resolution(did),
        defer: (work) => void deferred.push(work),
    }
    return {
        deps,
        appended,
        bodies,
        lookups,
        settle: () => Promise.all(deferred),
        setRecipientKnown: (known: boolean) => void (recipientKnown = known),
        setHasMailbox: (has: boolean) => void (hasMailbox = has),
    }
}

function put(secretKey: Uint8Array, recipientDID = RECIPIENT) {
    const body = encodePairPutEnvelope(
        {
            senderDID: SENDER,
            recipientDID,
            kid: new Uint8Array(32).fill(0xaa),
            nonce: new Uint8Array(16).fill(1),
            payload: new TextEncoder().encode("sealed"),
        },
        (message) => ed25519.sign(message, secretKey)
    )
    return new Request("https://relay.example/pmr/v1/inbox/x/messages", {
        method: "POST",
        body,
    })
}

function keyPair() {
    const secretKey = ed25519.utils.randomSecretKey()
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

const known = (publicKey: Uint8Array) => (): SenderDeclarationResolution => ({
    found: true,
    anchorKey: { x: publicKey },
    declarationCID: DC,
})

describe("handlePairPut", () => {
    it("a verified put stores a ref whose hint carries the sender DID and the resolved declarationCID", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world(known(publicKey))
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.appended).toHaveLength(1)
        expect(w.appended[0]!.ref.hint).toEqual({ senderDID: SENDER, declarationCID: DC })
        expect(w.bodies).toHaveLength(1)
    })

    it("no known declaration → 409 with Retry-After, nothing appended, no body stored", async () => {
        const { secretKey } = keyPair()
        const w = world(() => ({ found: false, reason: "no snapshot held" }))
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(409)
        expect(response.headers.get("Retry-After")).toBe(String(DECLARATION_RETRY_AFTER_SECONDS))
        expect(w.appended).toEqual([])
        expect(w.bodies).toEqual([])
        expect(await response.text()).toBe("")
    })

    it("signature fails under the known anchor key → 409 with Retry-After, nothing appended, no body stored", async () => {
        const { secretKey } = keyPair()
        const w = world(known(keyPair().publicKey))
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        await w.settle()
        expect(response.status).toBe(409)
        expect(response.headers.get("Retry-After")).toBe(String(DECLARATION_RETRY_AFTER_SECONDS))
        expect(w.appended).toEqual([])
        expect(w.bodies).toEqual([])
    })

    it("a 409 is decided before any directory lookup (unknown recipient cannot change it)", async () => {
        const { secretKey } = keyPair()
        const w = world(() => ({ found: false, reason: "stale" }))
        w.setRecipientKnown(false)
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(409)
        expect(w.lookups).toEqual([])
    })

    it("a validly signed put naming a different recipient still answers 202 and stores nothing", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world(known(publicKey))
        const response = await handlePairPut(
            put(secretKey, "did:plc:someoneelse0000000000000"),
            RECIPIENT,
            w.deps,
            NOW
        )
        await w.settle()
        expect(response.status).toBe(202)
        expect(w.appended).toEqual([])
        expect(w.bodies).toEqual([])
    })

    it("an unknown recipient with a verifiable put still answers 202", async () => {
        const { secretKey, publicKey } = keyPair()
        const w = world(known(publicKey))
        w.setRecipientKnown(false)
        const response = await handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)
        expect(response.status).toBe(202)
        expect(w.lookups).toEqual([RECIPIENT])
        expect(w.appended).toEqual([])
    })

    it("a resolver fault propagates as a relay fault rather than answering 409", async () => {
        const { secretKey } = keyPair()
        const w = world(() => {
            throw new Error("kv down")
        })
        await expect(handlePairPut(put(secretKey), RECIPIENT, w.deps, NOW)).rejects.toThrow("kv down")
        expect(w.appended).toEqual([])
    })
})
