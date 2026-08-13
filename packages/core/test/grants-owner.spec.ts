/**
 * The owner-facing grant surface: issue, list, close/reopen, delete.
 *
 * Two properties matter beyond "the happy path works":
 *   - an owner never gets `key` back from anything except issuance itself;
 *   - `PATCH`/`DELETE` check OWNERSHIP against the caller's own record
 *     before touching the global routing row, so naming someone else's
 *     address by value cannot mutate it.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodeBinding } from "../src/challenge"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { deriveGrantAddress } from "../src/grant"
import { signRequest } from "../src/http-sig/sign"
import {
    handleGrantDelete,
    handleGrantSet,
    handleGrantsCreate,
    handleGrantsList,
    type GrantConfig,
    type OwnerDeps,
} from "../src/owner/endpoints"
import type {
    ChallengeStore,
    Directory,
    GrantSummary,
    Locator,
    PMRStore,
    RegistrationFields,
} from "../src/storage"

const T0 = 1_760_000_000
const HOST = "relay.example"
const ORIGIN = "https://relay.example"
const GRANTS_URL = `${ORIGIN}/pmr/v1/grants`

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

interface AddressRow {
    locator: string
    authKey: Uint8Array
    closed: boolean
}

/** Set by the write-order test to make the routing write fail. */
let failRoutingWrite = false

function world() {
    const registrations = new Map<string, RegistrationFields>()
    const addressRows = new Map<string, AddressRow>()
    const grantsByLocator = new Map<string, Map<string, GrantSummary>>()
    const challenges = memoryChallenges()

    const directory: Directory = {
        async resolve(did) {
            return registrations.has(did) ? `loc:${did}` : null
        },
        async resolveAddress(address) {
            const row = addressRows.get(address)
            if (row === undefined) return null
            return { locator: row.locator, closed: row.closed, authKey: row.authKey }
        },
        async create(did, registration) {
            if (!registrations.has(did)) registrations.set(did, registration)
            return `loc:${did}`
        },
        async delete(did) {
            registrations.delete(did)
        },
        async createGrantAddress(locator, address, authKey, _expiresAt) {
            if (failRoutingWrite) throw new Error("routing write failed")
            addressRows.set(address, { locator, authKey, closed: false })
        },
        async setGrantAddressClosed(address, closed) {
            const row = addressRows.get(address)
            if (row !== undefined) row.closed = closed
        },
        async deleteGrantAddress(address) {
            addressRows.delete(address)
        },
    }

    const store = (locator: Locator): PMRStore => {
        const did = locator.slice("loc:".length)
        if (!grantsByLocator.has(locator)) grantsByLocator.set(locator, new Map())
        const mine = grantsByLocator.get(locator)!
        return {
            load: async () => registrations.get(did) ?? null,
            update: async (fields) => {
                registrations.set(did, {
                    ...registrations.get(did),
                    ...fields,
                } as RegistrationFields)
            },
            issueGrant: async (address, _authKey, expiresAt) => {
                mine.set(address, { address, expiresAt, closed: false })
            },
            listGrants: async () => [...mine.values()],
            getGrant: async (address) => mine.get(address) ?? null,
            setGrantClosed: async (address, closed) => {
                const g = mine.get(address)
                if (g !== undefined) mine.set(address, { ...g, closed })
            },
            invalidateGrant: async (address) => {
                mine.delete(address)
            },
        } as unknown as PMRStore
    }

    return { registrations, addressRows, grantsByLocator, challenges, directory, store }
}

let keyCounter = 0
function randomBytes(n: number): Uint8Array {
    keyCounter += 1
    const out = new Uint8Array(n)
    new DataView(out.buffer).setUint32(0, keyCounter)
    return out
}

function deps(w: ReturnType<typeof world>): OwnerDeps & GrantConfig {
    return {
        challenges: w.challenges,
        directory: w.directory,
        resolveLocator: (did) => w.directory.resolve(did),
        store: w.store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        hostName: HOST,
        grantExpirySeconds: 3600,
        maxGrantsPerRequest: 5,
        randomBytes,
    }
}

async function challengeFor(w: ReturnType<typeof world>, did: string) {
    const c = `chal-${Math.random().toString(36).slice(2)}`
    await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    return c
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

/**
 * `handleGrantsCreate` etc. authenticate via `authenticateOwner`, which
 * verifies against the STORED anchor key. Registering with the real
 * public key (rather than stubbing auth) keeps these tests honest about
 * the same authentication path every other owner-facing test exercises.
 */
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

describe("POST /pmr/v1/grants — issuance", () => {
    it("issues N grants, each address matching the published derivation", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000000"
        const secretKey = await registeredOwner(w, did)

        const body = encodeCose(new Map<string, CoseValue>([["count", 3]]))
        const response = await handleGrantsCreate(
            signedRequest(GRANTS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(201)

        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        const grants = map.get("grants") as Map<string, CoseValue>[]
        expect(grants).toHaveLength(3)

        const addresses = new Set<string>()
        for (const g of grants) {
            const key = g.get("key") as Uint8Array
            const address = g.get("address") as string
            expect(g.get("expiry")).toBe(T0 + 3600)
            expect([...deriveGrantAddress(key, HOST)]).toEqual(
                [...Buffer.from(address.replace(/-/g, "+").replace(/_/g, "/"), "base64")]
            )
            addresses.add(address)
        }
        // Distinct keys produce distinct addresses.
        expect(addresses.size).toBe(3)
    })

    it("refuses a request for more than maxGrantsPerRequest", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000001"
        const secretKey = await registeredOwner(w, did)

        const body = encodeCose(new Map<string, CoseValue>([["count", 6]]))
        const response = await handleGrantsCreate(
            signedRequest(GRANTS_URL, "POST", secretKey, await challengeFor(w, did), body),
            deps(w)
        )
        expect(response.status).toBe(400)
    })

    it("refuses an unauthenticated request", async () => {
        const w = world()
        const body = encodeCose(new Map<string, CoseValue>([["count", 1]]))
        const response = await handleGrantsCreate(
            new Request(GRANTS_URL, { method: "POST", body }),
            deps(w)
        )
        expect(response.status).toBe(401)
    })
})

describe("GET /pmr/v1/grants — listing", () => {
    it("lists issued grants without ever including key", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000002"
        const secretKey = await registeredOwner(w, did)

        await handleGrantsCreate(
            signedRequest(
                GRANTS_URL,
                "POST",
                secretKey,
                await challengeFor(w, did),
                encodeCose(new Map<string, CoseValue>([["count", 2]]))
            ),
            deps(w)
        )

        const response = await handleGrantsList(
            signedRequest(GRANTS_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        expect(response.status).toBe(200)
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        const grants = map.get("grants") as Map<string, CoseValue>[]
        expect(grants).toHaveLength(2)
        for (const g of grants) {
            expect([...g.keys()].sort()).toEqual(["address", "closed", "expiry"])
            expect(g.get("closed")).toBe(false)
        }
    })

    it("an owner with no grants sees an empty list, not an error", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000003"
        const secretKey = await registeredOwner(w, did)

        const response = await handleGrantsList(
            signedRequest(GRANTS_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        expect(response.status).toBe(200)
        const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
        expect(map.get("grants")).toEqual([])
    })
})

async function issueOneGrant(
    w: ReturnType<typeof world>,
    did: string,
    secretKey: Uint8Array
): Promise<string> {
    const response = await handleGrantsCreate(
        signedRequest(
            GRANTS_URL,
            "POST",
            secretKey,
            await challengeFor(w, did),
            encodeCose(new Map<string, CoseValue>([["count", 1]]))
        ),
        deps(w)
    )
    const map = decodeCoseMap(new Uint8Array(await response.arrayBuffer()))
    const grants = map.get("grants") as Map<string, CoseValue>[]
    return grants[0].get("address") as string
}

describe("issuance write order fails toward the inert half", () => {
    it("a failed routing write leaves a grant that is revocable, not one that is live-but-unrevocable", async () => {
        // The owner record MUST be written first. Reversed, a failure here
        // would leave a routing row puts land on while `getGrant` returns
        // null — so PATCH/DELETE answer 404 and the owner cannot revoke it
        // until its own expiry lapses.
        const w = world()
        const did = "did:plc:owner0000000000000006"
        const secretKey = await registeredOwner(w, did)

        failRoutingWrite = true
        try {
            await expect(
                handleGrantsCreate(
                    signedRequest(
                        GRANTS_URL,
                        "POST",
                        secretKey,
                        await challengeFor(w, did),
                        encodeCose(new Map<string, CoseValue>([["count", 1]]))
                    ),
                    deps(w)
                )
            ).rejects.toThrow("routing write failed")
        } finally {
            failRoutingWrite = false
        }

        // Nothing routes — a put cannot reach it.
        expect(w.addressRows.size).toBe(0)

        // But the owner can see it and delete it: the failure is inert.
        const list = await handleGrantsList(
            signedRequest(GRANTS_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        const listed = decodeCoseMap(new Uint8Array(await list.arrayBuffer()))
        const grants = listed.get("grants") as Map<string, CoseValue>[]
        expect(grants).toHaveLength(1)
        const orphan = grants[0].get("address") as string

        const deleted = await handleGrantDelete(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${orphan}`,
                "DELETE",
                secretKey,
                await challengeFor(w, did)
            ),
            orphan,
            deps(w)
        )
        expect(deleted.status).toBe(204)
    })
})

describe("PATCH /pmr/v1/grants/{address} — close/reopen", () => {
    it("closes and reopens, reflected in both the owner's list and global resolution", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000004"
        const secretKey = await registeredOwner(w, did)
        const address = await issueOneGrant(w, did, secretKey)

        const closeBody = encodeCose(new Map<string, CoseValue>([["closed", true]]))
        const closed = await handleGrantSet(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${address}`,
                "PATCH",
                secretKey,
                await challengeFor(w, did),
                closeBody
            ),
            address,
            deps(w)
        )
        expect(closed.status).toBe(204)
        expect((await w.directory.resolveAddress(address))!.closed).toBe(true)

        const reopenBody = encodeCose(new Map<string, CoseValue>([["closed", false]]))
        const reopened = await handleGrantSet(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${address}`,
                "PATCH",
                secretKey,
                await challengeFor(w, did),
                reopenBody
            ),
            address,
            deps(w)
        )
        expect(reopened.status).toBe(204)
        expect((await w.directory.resolveAddress(address))!.closed).toBe(false)
    })

    it("refuses to touch an address the caller did not issue", async () => {
        const w = world()
        const aliceDid = "did:plc:alice00000000000000000"
        const alice = await registeredOwner(w, aliceDid)
        const bobDid = "did:plc:bob000000000000000000000"
        const bob = await registeredOwner(w, bobDid)

        const alicesAddress = await issueOneGrant(w, aliceDid, alice)

        const body = encodeCose(new Map<string, CoseValue>([["closed", true]]))
        const response = await handleGrantSet(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${alicesAddress}`,
                "PATCH",
                bob,
                await challengeFor(w, bobDid),
                body
            ),
            alicesAddress,
            deps(w)
        )
        expect(response.status).toBe(404)
        // Untouched.
        expect((await w.directory.resolveAddress(alicesAddress))!.closed).toBe(false)
    })
})

describe("DELETE /pmr/v1/grants/{address} — invalidate", () => {
    it("removes it from both the owner's list and global resolution", async () => {
        const w = world()
        const did = "did:plc:owner0000000000000005"
        const secretKey = await registeredOwner(w, did)
        const address = await issueOneGrant(w, did, secretKey)

        const response = await handleGrantDelete(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${address}`,
                "DELETE",
                secretKey,
                await challengeFor(w, did)
            ),
            address,
            deps(w)
        )
        expect(response.status).toBe(204)
        expect(await w.directory.resolveAddress(address)).toBeNull()

        const list = await handleGrantsList(
            signedRequest(GRANTS_URL, "GET", secretKey, await challengeFor(w, did)),
            deps(w)
        )
        const map = decodeCoseMap(new Uint8Array(await list.arrayBuffer()))
        expect(map.get("grants")).toEqual([])
    })

    it("refuses to delete an address the caller did not issue", async () => {
        const w = world()
        const aliceDid = "did:plc:alice10000000000000000"
        const alice = await registeredOwner(w, aliceDid)
        const bobDid = "did:plc:bob100000000000000000000"
        const bob = await registeredOwner(w, bobDid)
        const alicesAddress = await issueOneGrant(w, aliceDid, alice)

        const response = await handleGrantDelete(
            signedRequest(
                `${ORIGIN}/pmr/v1/grants/${alicesAddress}`,
                "DELETE",
                bob,
                await challengeFor(w, bobDid)
            ),
            alicesAddress,
            deps(w)
        )
        expect(response.status).toBe(404)
        expect(await w.directory.resolveAddress(alicesAddress)).not.toBeNull()
    })
})
