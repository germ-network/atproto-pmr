import { ed25519 } from "@noble/curves/ed25519.js"
import { describe, expect, it } from "vitest"
import { encodeBinding } from "../src/challenge"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import {
    decodeFrame,
    drainBacklog,
    encodeDeliveryFrame,
    messageEntryFields,
    RESERVED_ENTRY_KEYS,
} from "../src/events"
import { signRequest } from "../src/http-sig/sign"
import { handleMessagesList, type MessagesConfig, type OwnerDeps } from "../src/owner/endpoints"
import { buildMessagePushPayload } from "../src/push/payload"
import type {
    BodyStore,
    ChallengeStore,
    Directory,
    MessageRef,
    OpenMailboxesPage,
    PMRStore,
    RegistrationFields,
} from "../src/storage"

const DC = "bafyreidjhhf3zynnv3qugihpmh757j7uhexdk62kmt4bgjqwsacji75d4e"
const HINT = { senderDID: "did:plc:sender", declarationCID: DC }
const MESSAGE = new TextEncoder().encode("hi")
const KEY = "did:plc:alice"

function ref(ext?: MessageRef["ext"]): MessageRef {
    return { messageId: "m1", byteLength: 2, hint: HINT, ...(ext !== undefined ? { ext } : {}) }
}

const keysOf = (m: Map<string, CoseValue>) => [...m.keys()]

describe("entry extension fields", () => {
    it("a ref with no ext emits exactly k, id, m, sd, dc, byte-identical to before", () => {
        const fields = messageEntryFields(KEY, ref(), MESSAGE)
        expect(keysOf(fields)).toEqual(["k", "id", "m", "sd", "dc"])
        const withEmpty = messageEntryFields(KEY, ref({}), MESSAGE)
        expect(encodeCose(withEmpty)).toEqual(encodeCose(fields))
    })

    it("ext keys are emitted beside sd/dc in deterministic CBOR order", () => {
        const a = messageEntryFields(KEY, ref({ flag: true, zz: "x", aa: 1 }), MESSAGE)
        const b = messageEntryFields(KEY, ref({ aa: 1, zz: "x", flag: true }), MESSAGE)
        expect(a.get("flag")).toBe(true)
        expect(a.get("zz")).toBe("x")
        expect(a.get("aa")).toBe(1)
        expect(a.get("sd")).toBe("did:plc:sender")
        expect(encodeCose(a)).toEqual(encodeCose(b))
    })

    it("ext on a ref with no hint is never emitted", () => {
        const fields = messageEntryFields(
            KEY,
            { messageId: "m1", byteLength: 2, ext: { flag: true } },
            MESSAGE
        )
        expect(keysOf(fields)).toEqual(["k", "id", "m"])
        const noCid = messageEntryFields(
            KEY,
            { ...ref({ flag: true }), hint: { senderDID: "did:plc:sender" } as MessageRef["hint"] },
            MESSAGE
        )
        expect(noCid.has("flag")).toBe(false)
    })

    it("a reserved key (k, id, m, sd, dc, t) in ext is never emitted", () => {
        expect([...RESERVED_ENTRY_KEYS].sort()).toEqual(["dc", "id", "k", "m", "sd", "t"])
        const fields = messageEntryFields(
            KEY,
            ref({ k: "evil", id: "evil", m: "evil", sd: "evil", dc: "evil", t: "evil", flag: true }),
            MESSAGE
        )
        expect(fields.get("k")).toBe(KEY)
        expect(fields.get("id")).toBe("m1")
        expect(fields.get("m")).toEqual(MESSAGE)
        expect(fields.get("sd")).toBe("did:plc:sender")
        expect(fields.get("dc")).toBe(DC)
        expect(fields.has("t")).toBe(false)
        expect(fields.get("flag")).toBe(true)
    })

    it("the live socket frame, the socket drain, the GET /pmr/v1/messages entry and the full-form push all carry ext", async () => {
        const r = ref({ flag: true })

        const live = decodeFrame(encodeDeliveryFrame(KEY, r, MESSAGE))
        expect(live.body.get("flag")).toBe(true)

        const store = {
            async openMailboxes(): Promise<OpenMailboxesPage> {
                return { entries: [{ key: KEY, messages: [r] }], nextCursor: null }
            },
            async poolSenders() {
                return []
            },
        } as unknown as PMRStore
        const bodies: BodyStore = {
            async putBody() {},
            async getBody() {
                return MESSAGE
            },
            async deleteBody() {},
        }
        const frames: Uint8Array[] = []
        await drainBacklog({ store, bodies }, { grant: "active" }, (f) => frames.push(f))
        const drained = frames.map(decodeFrame).find((f) => f.type === "delivery")!
        expect(drained.body.get("flag")).toBe(true)

        const push = decodeCoseMap(
            buildMessagePushPayload({ key: KEY, ref: r, message: MESSAGE, maxSealedBytes: 10_000 })
        )
        expect(push.get("flag")).toBe(true)

        const rest = await restEntry(r)
        expect(rest.get("flag")).toBe(true)
        expect(rest.get("sd")).toBe("did:plc:sender")
    })

    it("ext cannot overwrite the push payload's type key", () => {
        const push = decodeCoseMap(
            buildMessagePushPayload({
                key: KEY,
                ref: ref({ t: "evil", flag: true }),
                message: MESSAGE,
                maxSealedBytes: 10_000,
            })
        )
        expect(push.get("t")).toBe("m")
        expect(push.get("flag")).toBe(true)
    })
})

async function restEntry(r: MessageRef): Promise<Map<string, CoseValue>> {
    const T0 = 1_760_000_000
    const origin = "https://relay.example"
    const did = "did:plc:alice0000000000000000"
    const secretKey = ed25519.utils.randomSecretKey()
    const registration: RegistrationFields = {
        did,
        anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(secretKey) }),
        lastActive: T0,
    }
    const rows = new Map<string, string>()
    const challenges: ChallengeStore = {
        async mint(c, boundTo) {
            rows.set(c, boundTo)
        },
        async consume(c) {
            const v = rows.get(c) ?? null
            rows.delete(c)
            return v
        },
    }
    const directory = {
        async resolve() {
            return "loc"
        },
    } as unknown as Directory
    const store = () =>
        ({
            load: async () => registration,
            async openMailboxes(): Promise<OpenMailboxesPage> {
                return { entries: [{ key: did, messages: [r] }], nextCursor: null }
            },
        }) as unknown as PMRStore
    const deps: OwnerDeps & MessagesConfig = {
        challenges,
        directory,
        resolveLocator: async () => "loc",
        store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        bodies: {
            async putBody() {},
            async getBody() {
                return MESSAGE
            },
            async deleteBody() {},
        },
        catchUpPageMailboxes: 2,
        maxAcksPerRequest: 3,
    }
    const nonce = "chal-ext"
    await challenges.mint(nonce, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
    const url = `${origin}/pmr/v1/messages`
    const parts = signRequest({ method: "GET", url, nonce, keyid: "t", secretKey })
    const response = await handleMessagesList(
        new Request(url, { method: "GET", headers: parts.headers }),
        deps
    )
    expect(response.status).toBe(200)
    const ms = decodeCoseMap(new Uint8Array(await response.arrayBuffer())).get("ms") as Map<
        string,
        CoseValue
    >[]
    return ms[0]
}
