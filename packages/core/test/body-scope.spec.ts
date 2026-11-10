/**
 * Every storage effect of a put, a recycle or a read reaches only the
 * mailbox it was authorized for. Bodies here share one store across
 * registrations, as a KV-backed adapter does, so a body keyed by anything two
 * mailboxes can share would let one mailbox's recycle delete another's body.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import { describe, expect, it } from "vitest"
import { ingestAuthenticatedPut, type AuthenticatedPut } from "../src/authenticated-put"
import type { PMRConfig } from "../src/config"
import { encodeCose } from "../src/cose/cbor"
import { computeGrantPutTag } from "../src/grant"
import { handleGrantPut } from "../src/grant-put"
import { messageIdFor } from "../src/message-id"
import type { MessageRef, PMRStore } from "../src/storage"

const CONFIG = {
    limits: { messageMaxBytes: 100, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 },
} as unknown as PMRConfig
const NOW = 1_000
const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"

const SECRET = new TextEncoder().encode("sealed for the victim")
const OTHER = new TextEncoder().encode("different bytes")

type Sender = AuthenticatedPut["senderDID"]
const VICTIM_SENDER = "did:plc:victimsender0000000000000" as Sender
const ATTACKER = "did:plc:attacker000000000000000" as Sender

interface Mailbox {
    revision: number
    queue: MessageRef[]
    request: MessageRef[]
}

/**
 * Per-(locator, key) in-memory mailboxes whose `appendPair` recycles that
 * mailbox's own refs when the evidence revision advances, plus ONE body map
 * shared by every registration.
 */
function world(opts: { open?: (locator: string, key: string) => boolean } = {}) {
    const mailboxes = new Map<string, Mailbox>()
    const bodies = new Map<string, Uint8Array>()
    const deferred: Promise<unknown>[] = []
    const mailbox = (locator: string, key: string) => {
        const slot = `${locator}\0${key}`
        let found = mailboxes.get(slot)
        if (found === undefined) {
            found = { revision: 0, queue: [], request: [] }
            mailboxes.set(slot, found)
        }
        return found
    }
    const storeFor = (locator: string) =>
        ({
            appendPair: async (
                key: string, ref: MessageRef, _replay: Uint8Array, _now: number,
                evidence: { declarationCID: string; revision: string }
            ) => {
                const box = mailbox(locator, key)
                const revision = Number(evidence.revision)
                const recycledMessageIds = revision > box.revision
                    ? [...box.queue, ...box.request].map((r) => r.messageId)
                    : []
                if (revision > box.revision) {
                    box.revision = revision
                    box.queue = []
                    box.request = []
                }
                const open = opts.open?.(locator, key) ?? true
                ;(open ? box.queue : box.request).push(ref)
                return {
                    result: open
                        ? { outcome: "appended", persistBody: true }
                        : { outcome: "held" },
                    generation: `generation-${revision}`,
                    evidenceCID: evidence.declarationCID,
                    generationChanged: recycledMessageIds.length > 0,
                    recycledMessageIds,
                }
            },
            deliverLive: async () => {},
            deliverPush: async () => {},
            append: async (key: string, ref: MessageRef) => {
                mailbox(locator, key).queue.push(ref)
                return { outcome: "appended", persistBody: true }
            },
        }) as unknown as PMRStore
    const bodyStore = {
        putBody: async (id: string, bytes: Uint8Array) => void bodies.set(id, bytes),
        getBody: async (id: string) => bodies.get(id) ?? null,
        deleteBody: async (id: string) => void bodies.delete(id),
    }
    const deps = {
        config: CONFIG,
        directory: { resolve: async (did: string) => `loc:${did}` } as never,
        store: storeFor,
        bodies: bodyStore as never,
        defer: (work: Promise<unknown>) => void deferred.push(work),
    }
    return { deps, bodies, mailboxes, settle: () => Promise.all(deferred) }
}

async function put(
    w: ReturnType<typeof world>,
    recipient: string,
    sender: Sender,
    payload: Uint8Array,
    revision: number
) {
    const result = await ingestAuthenticatedPut(
        {
            recipientDID: recipient as never,
            senderDID: sender,
            declarationCID: DC,
            payload,
            replayKey: Uint8Array.of(revision, payload.length),
            evidence: { declarationCID: DC, revision: String(revision) },
        } as unknown as AuthenticatedPut,
        w.deps,
        NOW
    )
    await w.settle()
    return result
}

const queuedId = (w: ReturnType<typeof world>, locator: string, key: string) =>
    w.mailboxes.get(`${locator}\0${key}`)!.queue[0]!.messageId

const idAt = (locator: string, key: string, payload: Uint8Array) =>
    messageIdFor({ locator, key: key as never }, payload)

describe("body storage stays within its mailbox", () => {
    it("an attacker's rotation in its own registration does not delete a victim's body holding the same bytes", async () => {
        const w = world()
        const R = "did:plc:recipientv0000000000000"
        const attackerHost = "did:plc:attackerhost000000000000"
        await put(w, R, VICTIM_SENDER, SECRET, 1)
        const victimBody = queuedId(w, `loc:${R}`, VICTIM_SENDER)
        expect(w.bodies.has(victimBody)).toBe(true)

        await put(w, attackerHost, ATTACKER, SECRET, 1)
        await put(w, attackerHost, ATTACKER, OTHER, 2)

        expect(w.bodies.get(victimBody)).toEqual(SECRET)
        expect(w.bodies.has(idAt(`loc:${attackerHost}`, ATTACKER, SECRET))).toBe(false)
    })

    it("a stranger's rotation in the victim's request mailbox does not delete the victim's queued body holding the same bytes", async () => {
        const w = world({ open: (_locator, key) => key === VICTIM_SENDER })
        const R = "did:plc:recipientv0000000000000"
        await put(w, R, VICTIM_SENDER, SECRET, 1)
        const victimBody = queuedId(w, `loc:${R}`, VICTIM_SENDER)

        await put(w, R, ATTACKER, SECRET, 1)
        await put(w, R, ATTACKER, OTHER, 2)

        expect(w.bodies.get(victimBody)).toEqual(SECRET)
        expect(w.bodies.has(idAt(`loc:${R}`, ATTACKER, SECRET))).toBe(false)
    })

    it("a sender rotating in one recipient's registration keeps the identical bytes it queued for another recipient", async () => {
        const w = world()
        const first = "did:plc:recipienta0000000000000"
        const second = "did:plc:recipientb0000000000000"
        await put(w, first, VICTIM_SENDER, SECRET, 1)
        await put(w, second, VICTIM_SENDER, SECRET, 1)
        const keptBody = queuedId(w, `loc:${second}`, VICTIM_SENDER)
        await put(w, first, VICTIM_SENDER, OTHER, 2)

        expect(w.bodies.has(idAt(`loc:${first}`, VICTIM_SENDER, SECRET))).toBe(false)
        expect(w.bodies.get(keptBody)).toEqual(SECRET)
    })

    it("the same bytes put to two grant mailboxes are stored under two ids", async () => {
        const authKey = new Uint8Array(32).fill(7)
        const w = world()
        const nonces: Uint8Array[] = []
        const deps = {
            ...w.deps,
            store: (locator: string) => {
                const store = w.deps.store(locator)
                return {
                    append: async (key: string, ref: MessageRef, nonce: Uint8Array) => {
                        nonces.push(nonce)
                        return store.append(key as never, ref, nonce, NOW)
                    },
                } as unknown as PMRStore
            },
            directory: {
                resolveAddress: async () => ({ locator: "loc:grants", closed: false, authKey }),
            } as never,
            challenges: {
                mint: async () => {},
                consume: async (challenge: string) => `grantPut:${challenge.split("|")[0]}`,
            },
        }
        for (const address of ["addrA", "addrB"]) {
            const nonce = `${address}|n`
            const tag = computeGrantPutTag(
                authKey, address, new TextEncoder().encode(nonce), sha256(SECRET)
            )
            const body = encodeCose(new Map([["n", nonce], ["t", tag], ["m", SECRET]]))
            const response = await handleGrantPut(
                new Request("https://relay.test/", { method: "POST", body }),
                address,
                deps,
                NOW
            )
            expect(response.status).toBe(202)
            await w.settle()
        }

        expect(nonces).toEqual([sha256(SECRET), sha256(SECRET)])
        const ids = [...w.bodies.keys()]
        expect(ids).toHaveLength(2)
        expect(new Set(ids)).toEqual(new Set([
            idAt("loc:grants", "grant:addrA", SECRET),
            idAt("loc:grants", "grant:addrB", SECRET),
        ]))
    })
})
