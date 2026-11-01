import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodeBinding } from "../src/challenge"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { signRequest } from "../src/http-sig/sign"
import {
    handleRegistrationCreate,
    handleRegistrationRead,
    RegistrationFieldError,
    type CommittedRegistration,
    type OwnerDeps,
    type RegistrationExtension,
} from "../src/owner/endpoints"
import type {
    ChallengeStore,
    Directory,
    Locator,
    PMRStore,
    RegistrationFields,
} from "../src/storage"
import { INITIAL_WATCH_STATE } from "../src/watch"

const T0 = 1_760_000_000
const DID = "did:plc:ext00000000000000000000"
const CREATE_URL = "https://relay.example/pmr/v1/registrations"
const READ_URL = "https://relay.example/pmr/v1/registration"

function world() {
    const rows = new Map<string, RegistrationFields>()
    const log: string[] = []
    const rows2 = new Map<string, string>()
    const challenges: ChallengeStore = {
        async mint(c, boundTo) {
            rows2.set(c, boundTo)
        },
        async consume(c) {
            const v = rows2.get(c)
            if (v === undefined) return null
            rows2.delete(c)
            return v
        },
    }
    const directory = {
        async resolve(did: string) {
            return rows.has(did) ? `loc:${did}` : null
        },
        async create(did: string, registration: RegistrationFields) {
            log.push("create")
            if (!rows.has(did)) rows.set(did, registration)
            return `loc:${did}`
        },
        async delete(did: string) {
            rows.delete(did)
        },
        async isTombstoned() {
            return false
        },
    } as unknown as Directory
    const store = (locator: Locator): PMRStore => {
        const did = locator.slice("loc:".length)
        return {
            load: async () => rows.get(did) ?? null,
            readWatchState: async () => INITIAL_WATCH_STATE,
            update: async (fields: Partial<RegistrationFields>) => {
                log.push("update")
                rows.set(did, { ...rows.get(did), ...fields } as RegistrationFields)
            },
        } as unknown as PMRStore
    }
    return { rows, log, challenges, directory, store }
}

type World = ReturnType<typeof world>

let declaredKey: Uint8Array = new Uint8Array(32)

function deps(w: World, registrationExtension?: RegistrationExtension) {
    return {
        challenges: w.challenges,
        directory: w.directory,
        resolveLocator: (did: string) => w.directory.resolve(did),
        store: w.store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        resolveAnchorKey: async () => declaredKey,
        ...(registrationExtension !== undefined ? { registrationExtension } : {}),
    } satisfies OwnerDeps & { resolveAnchorKey: () => Promise<Uint8Array> }
}

async function signed(
    w: World,
    url: string,
    method: string,
    secretKey: Uint8Array,
    body?: Uint8Array
) {
    const nonce = `chal-${Math.random().toString(36).slice(2)}`
    await w.challenges.mint(nonce, encodeBinding({ realm: "anchor", subject: DID }), T0 + 600)
    const parts = signRequest({ method, url, nonce, keyid: "t", secretKey, body })
    return new Request(url, {
        method,
        headers: parts.headers,
        ...(body !== undefined ? { body } : {}),
    })
}

function newKey(): Uint8Array {
    const k = ed25519.utils.randomSecretKey()
    declaredKey = ed25519.getPublicKey(k)
    return k
}

const create = async (
    w: World,
    key: Uint8Array,
    ext: RegistrationExtension | undefined,
    body?: Record<string, CoseValue>
) =>
    handleRegistrationCreate(
        await signed(
            w,
            CREATE_URL,
            "POST",
            key,
            body === undefined ? undefined : encodeCose(new Map(Object.entries(body)))
        ),
        deps(w, ext)
    )

const read = async (w: World, key: Uint8Array, ext: RegistrationExtension | undefined) =>
    handleRegistrationRead(await signed(w, READ_URL, "GET", key), deps(w, ext))

const readMap = async (response: Response) =>
    decodeCoseMap(new Uint8Array(await response.arrayBuffer()))

/** Stores `x`, an integer, when the body carries it. */
function extension(overrides: Partial<RegistrationExtension> = {}): RegistrationExtension {
    return {
        parseCreateFields(body) {
            const x = body.get("x")
            if (x === undefined) return {}
            if (typeof x !== "number") throw new RegistrationFieldError("x")
            return { x }
        },
        ...overrides,
    }
}

describe("registration extension: fields", () => {
    it("with no extension configured, create stores no ext and read encodes exactly did, st, ps", async () => {
        const w = world()
        const key = newKey()
        expect((await create(w, key, undefined, { x: 1 })).status).toBe(201)
        expect("ext" in w.rows.get(DID)!).toBe(false)
        const map = await readMap(await read(w, key, undefined))
        expect([...map.keys()].sort()).toEqual(["did", "ps", "st"])
    })

    it("parseCreateFields sees the decoded body, or an empty map for an empty body", async () => {
        const seen: Array<ReadonlyMap<number | string, CoseValue>> = []
        const ext = extension({
            parseCreateFields(body) {
                seen.push(body)
                return {}
            },
        })
        const w = world()
        const key = newKey()
        await create(w, key, ext, { x: 5 })
        await create(w, key, ext)
        expect(seen[0]!.get("x")).toBe(5)
        expect(seen[1]!.size).toBe(0)
    })

    it("RegistrationFieldError from parseCreateFields answers 400 and stores nothing", async () => {
        const w = world()
        const key = newKey()
        const response = await create(w, key, extension(), { x: "nope" })
        expect(response.status).toBe(400)
        expect(w.rows.size).toBe(0)
        expect(w.log).toEqual([])
    })

    it("an error other than RegistrationFieldError is not a 400", async () => {
        const w = world()
        const key = newKey()
        const ext = extension({
            parseCreateFields() {
                throw new Error("bug")
            },
        })
        await expect(create(w, key, ext, { x: 1 })).rejects.toThrow("bug")
    })

    it("a same-key re-register replaces ext whole, so an omitted key is withdrawn", async () => {
        const w = world()
        const key = newKey()
        await create(w, key, extension(), { x: 1 })
        expect(w.rows.get(DID)!.ext).toEqual({ x: 1 })
        await create(w, key, extension())
        expect(w.rows.get(DID)!.ext).toEqual({})
    })

    it("a different-key re-register stores the new ext on the fresh registration", async () => {
        const w = world()
        await create(w, newKey(), extension(), { x: 1 })
        await create(w, newKey(), extension(), { x: 2 })
        expect(w.rows.get(DID)!.ext).toEqual({ x: 2 })
    })

    it("readFields adds keys to GET /pmr/v1/registration but cannot shadow did, st or ps", async () => {
        const w = world()
        const key = newKey()
        const ext = extension({
            async readFields(reg) {
                return [
                    ["x", reg.ext?.x as number],
                    ["did", "evil"],
                    ["st", "evil"],
                    ["ps", "evil"],
                ]
            },
        })
        await create(w, key, ext, { x: 3 })
        const map = await readMap(await read(w, key, ext))
        expect(map.get("x")).toBe(3)
        expect(map.get("did")).toBe(DID)
        expect(map.get("st")).toBe("active")
        expect(map.get("ps")).toBe(false)
    })
})

describe("registration extension: commit hook", () => {
    it("onCommitted runs after the write with did, locator, anchorKey and ext, before the 201", async () => {
        const w = world()
        const key = newKey()
        const committed: CommittedRegistration[] = []
        const ext = extension({
            async onCommitted(registration) {
                w.log.push("hook")
                committed.push(registration)
                expect(w.rows.get(DID)!.ext).toEqual({ x: 4 })
            },
        })
        const response = await create(w, key, ext, { x: 4 })
        expect(response.status).toBe(201)
        expect(w.log).toEqual(["create", "update", "hook"])
        expect(committed).toEqual([
            {
                did: DID,
                locator: `loc:${DID}`,
                anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(key) }),
                ext: { x: 4 },
            },
        ])
        expect((await readMap(response)).get("l")).toBe(`loc:${DID}`)
    })

    it("a throwing onCommitted fails the request and a retry succeeds", async () => {
        const w = world()
        const key = newKey()
        let fail = true
        const ext = extension({
            async onCommitted() {
                if (fail) throw new Error("index down")
            },
        })
        await expect(create(w, key, ext, { x: 1 })).rejects.toThrow("index down")
        fail = false
        expect((await create(w, key, ext, { x: 1 })).status).toBe(201)
        expect(w.rows.get(DID)!.ext).toEqual({ x: 1 })
    })
})
