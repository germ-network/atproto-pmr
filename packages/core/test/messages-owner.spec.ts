/**
 * REST catch-up: `GET /pmr/v1/messages?cursor=` and `POST
 * /pmr/v1/messages/acks` — the fallback for a client that cannot hold
 * `GET /pmr/v1/events`'s socket.
 *
 * The properties worth pinning here are the ones an in-memory fake makes
 * easy to get wrong: an all-empty page must still advance the cursor, a
 * missing body must be skipped rather than failing the request, and a
 * malformed batch entry must fail the WHOLE acks request before anything
 * is removed.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodeBinding } from "../src/challenge"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { signRequest } from "../src/http-sig/sign"
import {
    handleMessagesAcks,
    handleMessagesList,
    type MessagesConfig,
    type OwnerDeps,
} from "../src/owner/endpoints"
import type {
    BodyStore,
    ChallengeStore,
    Directory,
    Locator,
    MailboxSnapshot,
    MessageRef,
    OpenMailboxesPage,
    PMRStore,
    RegistrationFields,
} from "../src/storage"

const T0 = 1_760_000_000
const ORIGIN = "https://relay.example"
const MESSAGES_URL = `${ORIGIN}/pmr/v1/messages`
const ACKS_URL = `${ORIGIN}/pmr/v1/messages/acks`

function ref(id: string, hint?: MessageRef["hint"]): MessageRef {
    return { messageId: id, byteLength: 5, hint }
}

function memoryChallenges(): ChallengeStore {
    const rows = new Map<string, string>()
    return {
        async mint(c, boundTo) {
            rows.set(c, boundTo)
        },
        async consume(c) {
            const v = rows.get(c)
            if (v === undefined) return null
            rows.delete(c)
            return v
        },
    }
}

/**
 * One `PMRStore` per registered DID, each with its own mailbox map — so a
 * test proving cross-owner isolation can populate two owners without one
 * seeing the other's queue.
 */
function world() {
    const registrations = new Map<string, RegistrationFields>()
    const challenges = memoryChallenges()
    const mailboxesByLocator = new Map<string, Map<string, MessageRef[]>>()
    const bodies = new Map<string, Uint8Array>()
    const removed: { locator: string; key: string; messageId: string }[] = []

    const directory = {
        async resolve(did: string): Promise<Locator | null> {
            return registrations.has(did) ? `loc:${did}` : null
        },
        async create(did: string, registration: RegistrationFields): Promise<Locator> {
            if (!registrations.has(did)) registrations.set(did, registration)
            return `loc:${did}`
        },
        async delete(did: string): Promise<void> {
            registrations.delete(did)
        },
    } as unknown as Directory

    function mailboxesFor(locator: Locator): Map<string, MessageRef[]> {
        if (!mailboxesByLocator.has(locator)) mailboxesByLocator.set(locator, new Map())
        return mailboxesByLocator.get(locator)!
    }

    const store = (locator: Locator): PMRStore => {
        const did = locator.slice("loc:".length)
        const mailboxes = mailboxesFor(locator)
        return {
            load: async () => registrations.get(did) ?? null,
            async openMailboxes(cursor, limit): Promise<OpenMailboxesPage> {
                const keys = [...mailboxes.keys()].sort()
                const startIndex = cursor === null ? 0 : keys.indexOf(cursor) + 1
                const page = keys.slice(startIndex, startIndex + limit)
                const entries: MailboxSnapshot[] = page.map((key) => ({
                    key,
                    messages: mailboxes.get(key)!,
                }))
                const nextCursor =
                    startIndex + limit < keys.length ? page[page.length - 1] : null
                return { entries, nextCursor }
            },
            async remove(key, messageId) {
                removed.push({ locator, key, messageId })
                const queue = mailboxes.get(key)
                if (queue === undefined) return
                mailboxes.set(key, queue.filter((r) => r.messageId !== messageId))
            },
        } as unknown as PMRStore
    }

    const bodyStore: BodyStore = {
        async putBody(id, bytes) {
            bodies.set(id, bytes)
        },
        async getBody(id) {
            return bodies.get(id) ?? null
        },
        async deleteBody(id) {
            bodies.delete(id)
        },
    }

    return { registrations, mailboxesByLocator, mailboxesFor, bodies, removed, challenges, directory, store, bodyStore }
}

function deps(
    w: ReturnType<typeof world>,
    overrides: Partial<OwnerDeps & MessagesConfig> = {}
): OwnerDeps & MessagesConfig {
    return {
        challenges: w.challenges,
        directory: w.directory,
        resolveLocator: (did) => w.directory.resolve(did),
        store: w.store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        bodies: w.bodyStore,
        catchUpPageMailboxes: 2,
        maxAcksPerRequest: 3,
        ...overrides,
    }
}

async function challengeFor(w: ReturnType<typeof world>, did: string) {
    const c = `chal-${Math.random().toString(36).slice(2)}`
    await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    return c
}

/** Mirrors `grants-owner.spec.ts`'s helper of the same name. */
async function registeredOwner(w: ReturnType<typeof world>, did: string) {
    const secretKey = ed25519.utils.randomSecretKey()
    const publicKey = ed25519.getPublicKey(secretKey)
    await w.directory.create(did, {
        did,
        anchorKey: encodeOkpEd25519Key({ x: publicKey }),
        lastActive: T0,
    })
    return secretKey
}

function signedRequest(
    url: string,
    method: string,
    secretKey: Uint8Array,
    nonce: string,
    body?: Uint8Array
): Request {
    const parts = signRequest({ method, url, nonce, keyid: "t", secretKey, body })
    return new Request(url, {
        method,
        headers: parts.headers,
        ...(body !== undefined ? { body } : {}),
    })
}

describe("GET /pmr/v1/messages — catch-up", () => {
    it("refuses an unauthenticated request", async () => {
        const w = world()
        const response = await handleMessagesList(new Request(MESSAGES_URL), deps(w))
        expect(response.status).toBe(401)
    })

    it("carries k/id/m, and sd/kt only when the ref has a hint", async () => {
        const w = world()
        const did = "did:plc:alice0000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        const mailboxes = w.mailboxesFor(locator)

        mailboxes.set(did, [
            ref("m1", { senderDID: "did:plc:sender", anchorKeyThumbprint: "abcd" }),
        ])
        mailboxes.set("grant:addr", [ref("m2")])
        w.bodies.set("m1", new TextEncoder().encode("hello"))
        w.bodies.set("m2", new TextEncoder().encode("world"))

        const response = await handleMessagesList(
            signedRequest(MESSAGES_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        expect(response.status).toBe(200)
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        const ms = map.get("ms") as Map<string, CoseValue>[]
        expect(ms).toHaveLength(2)

        const pairEntry = ms.find((m) => m.get("id") === "m1")!
        expect(pairEntry.get("k")).toBe(did)
        expect(pairEntry.get("m")).toEqual(new TextEncoder().encode("hello"))
        expect(pairEntry.get("sd")).toBe("did:plc:sender")
        expect(pairEntry.get("kt")).toBe("abcd")

        const grantEntry = ms.find((m) => m.get("id") === "m2")!
        expect(grantEntry.get("k")).toBe("grant:addr")
        expect(grantEntry.has("sd")).toBe(false)
        expect(grantEntry.has("kt")).toBe(false)
    })

    it("pages through more mailboxes than fit on one page, per-mailbox FIFO preserved", async () => {
        const w = world()
        const did = "did:plc:bob00000000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        const mailboxes = w.mailboxesFor(locator)

        for (let i = 0; i < 5; i++) {
            mailboxes.set(`did:plc:m${i}`, [ref(`first${i}`), ref(`second${i}`)])
            w.bodies.set(`first${i}`, new Uint8Array([i, 0]))
            w.bodies.set(`second${i}`, new Uint8Array([i, 1]))
        }

        const seen: string[] = []
        let cursor: string | null = null
        for (let page = 0; page < 10; page++) {
            const url = cursor === null ? MESSAGES_URL : `${MESSAGES_URL}?cursor=${cursor}`
            const response = await handleMessagesList(
                signedRequest(url, "GET", secretKey, await challengeFor(w, did)),
                deps(w)
            )
            const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
            const ms = map.get("ms") as Map<string, CoseValue>[]
            for (const m of ms) seen.push(m.get("id") as string)
            cursor = map.get("n") as string | null
            if (cursor === null) break
        }

        expect(seen).toHaveLength(10)
        // Per-mailbox FIFO: each mailbox's own two messages stay in order.
        for (let i = 0; i < 5; i++) {
            expect(seen.indexOf(`first${i}`)).toBeLessThan(seen.indexOf(`second${i}`))
        }
    })

    it("an all-empty page still advances the cursor, rather than looking like the end", async () => {
        const w = world()
        const did = "did:plc:carol0000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        const mailboxes = w.mailboxesFor(locator)

        // Two provisioned-but-empty mailboxes sort before the one with a
        // real message; page size 2 puts both empties on page 1 alone.
        mailboxes.set("did:plc:empty-a", [])
        mailboxes.set("did:plc:empty-b", [])
        mailboxes.set("did:plc:has-mail", [ref("real")])
        w.bodies.set("real", new Uint8Array([9]))

        const first = await handleMessagesList(
            signedRequest(MESSAGES_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        const firstMap = decodeCoseMap(new Uint8Array(await first.arrayBuffer()))
        expect(firstMap.get("ms")).toEqual([])
        expect(firstMap.get("n")).not.toBeNull()

        const second = await handleMessagesList(
            signedRequest(
                `${MESSAGES_URL}?cursor=${firstMap.get("n")}`,
                "GET",
                secretKey,
                await challengeFor(w, did)
            ),
            deps(w)
        )
        const secondMap = decodeCoseMap(new Uint8Array(await second.arrayBuffer()))
        const ms = secondMap.get("ms") as Map<string, CoseValue>[]
        expect(ms).toHaveLength(1)
        expect(ms[0].get("id")).toBe("real")
        expect(secondMap.get("n")).toBeNull()
    })

    it("skips a ref whose body is missing rather than failing the request", async () => {
        const w = world()
        const did = "did:plc:dave00000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        w.mailboxesFor(locator).set(did, [ref("gone"), ref("here")])
        w.bodies.set("here", new Uint8Array([1])) // "gone"'s body is missing

        const response = await handleMessagesList(
            signedRequest(MESSAGES_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        const ms = map.get("ms") as Map<string, CoseValue>[]
        expect(ms).toHaveLength(1)
        expect(ms[0].get("id")).toBe("here")
    })

    it("`n` is null once every mailbox has been paged through", async () => {
        const w = world()
        const did = "did:plc:erin00000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        w.mailboxesFor(locator).set(did, [ref("m1")])
        w.bodies.set("m1", new Uint8Array([1]))

        const response = await handleMessagesList(
            signedRequest(MESSAGES_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        expect(map.get("n")).toBeNull()
    })
})

describe("POST /pmr/v1/messages/acks — batch ack", () => {
    function ackBody(acks: { k: string; id: string }[]): Uint8Array {
        return encodeCose(
            new Map<string, CoseValue>([
                [
                    "a",
                    acks.map(
                        (a) => new Map<string, CoseValue>([["k", a.k], ["id", a.id]])
                    ),
                ],
            ])
        )
    }

    it("refuses an unauthenticated request", async () => {
        const w = world()
        const response = await handleMessagesAcks(
            new Request(ACKS_URL, { method: "POST", body: ackBody([]) }),
            deps(w)
        )
        expect(response.status).toBe(401)
    })

    it("removes every named message, and answers 204", async () => {
        const w = world()
        const did = "did:plc:frank000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        w.mailboxesFor(locator).set(did, [ref("m1"), ref("m2")])

        const body = ackBody([{ k: did, id: "m1" }, { k: did, id: "m2" }])
        const response = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(204)
        expect(w.mailboxesFor(locator).get(did)).toEqual([])
    })

    it("re-posting the identical batch is a no-op — acks are idempotent", async () => {
        const w = world()
        const did = "did:plc:grace000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        w.mailboxesFor(locator).set(did, [ref("m1")])

        const body = ackBody([{ k: did, id: "m1" }])
        const first = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(first.status).toBe(204)

        const second = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(second.status).toBe(204)
    })

    it("acking a messageId that never existed still succeeds", async () => {
        const w = world()
        const did = "did:plc:henry000000000000000"
        const secretKey = await registeredOwner(w, did)

        const body = ackBody([{ k: did, id: "never-was" }])
        const response = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(204)
    })

    it("refuses a batch of more than maxAcksPerRequest", async () => {
        const w = world()
        const did = "did:plc:ivy0000000000000000000"
        const secretKey = await registeredOwner(w, did)

        const body = ackBody([
            { k: did, id: "m1" },
            { k: did, id: "m2" },
            { k: did, id: "m3" },
            { k: did, id: "m4" },
        ])
        const response = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(400)
    })

    it("a key matching neither mailbox prefix fails the WHOLE batch, and removes nothing", async () => {
        const w = world()
        const did = "did:plc:jack000000000000000"
        const secretKey = await registeredOwner(w, did)
        const locator = (await w.directory.resolve(did))!
        w.mailboxesFor(locator).set(did, [ref("m1")])

        const body = ackBody([{ k: did, id: "m1" }, { k: "not-a-valid-key", id: "m2" }])
        const response = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(400)
        // Nothing removed -- validate-before-execute, not partial success.
        expect(w.mailboxesFor(locator).get(did)).toEqual([ref("m1")])
        expect(w.removed).toEqual([])
    })

    it("responses carry Germ-Next-Challenge — the amortized re-mint", async () => {
        const w = world()
        const did = "did:plc:kim0000000000000000000"
        const secretKey = await registeredOwner(w, did)
        const randomBytes = (n: number) => new Uint8Array(n).fill(7)

        const response = await handleMessagesAcks(
            signedRequest(ACKS_URL, "POST", secretKey, await challengeFor(w, did), ackBody([])),
            deps(w, {
                challengeConfig: { ttlSeconds: 600, byteLength: 32 },
                randomBytes,
            })
        )
        expect(response.status).toBe(204)
        expect(response.headers.get("Germ-Next-Challenge")).not.toBeNull()
    })
})

describe("cross-owner isolation", () => {
    it("catch-up returns only the caller's own mailboxes", async () => {
        const w = world()
        const aliceDid = "did:plc:alice1000000000000000"
        const alice = await registeredOwner(w, aliceDid)
        const bobDid = "did:plc:bob10000000000000000000"
        const bob = await registeredOwner(w, bobDid)

        const aliceLocator = (await w.directory.resolve(aliceDid))!
        w.mailboxesFor(aliceLocator).set(aliceDid, [ref("alices-message")])
        w.bodies.set("alices-message", new Uint8Array([1]))

        const response = await handleMessagesList(
            signedRequest(MESSAGES_URL, "GET", bob, await challengeFor(w, bobDid)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        expect(map.get("ms")).toEqual([])
    })
})
