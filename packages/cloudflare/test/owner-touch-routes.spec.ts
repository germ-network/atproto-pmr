/**
 * Which traffic records owner activity (D-24) and which never does.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    authenticateOwner,
    decodeFrame,
    encodeBinding,
    encodeCose,
    computeGrantPutTag,
    handleGrantPut,
    ingestAuthenticatedPut,
    type CoseValue,
    encodeOkpEd25519Key,
    grantMailboxKey,
    signRequest,
    type ChallengeStore,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory, kvBodyStore, pmrStore } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"
import { inPMR } from "./helpers"

const testEnv = env as unknown as PMREnv<PMRObject>
const DAY = 86_400
const MIDNIGHT = 20_000 * DAY

function memoryChallenges(): ChallengeStore {
    const rows = new Map<string, string>()
    return {
        async mint(c, boundTo) {
            rows.set(c, boundTo)
        },
        async consume(c) {
            const v = rows.get(c)
            rows.delete(c)
            return v ?? null
        },
    }
}

describe("auth site", () => {
    it("authenticateOwner against a real PMRObject touches it", async () => {
        const directory = new KVDirectory(testEnv)
        const secretKey = ed25519.utils.randomSecretKey()
        const did = "did:plc:owner-touch-auth"
        // The stored blob, not raw key bytes, is what the DO compares against.
        await directory.create(did, {
            did,
            anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(secretKey) }),
            lastActive: MIDNIGHT - 10,
        })
        const challenges = memoryChallenges()
        await challenges.mint("n1", encodeBinding({ realm: "anchor", subject: did }), MIDNIGHT + 600)
        const url = "https://relay.example/pmr/v1/registration"
        const parts = signRequest({ method: "GET", url, nonce: "n1", keyid: "t", secretKey })

        const auth = await authenticateOwner(new Request(url, { headers: parts.headers }), null, {
            challenges,
            resolveLocator: (d) => directory.resolve(d),
            store: (locator) => pmrStore(locator, testEnv),
            nowSeconds: MIDNIGHT + 3_000,
        })

        expect(auth.authenticated).toBe(true)
        const stored = await pmrStore((await directory.resolve(did))!, testEnv).load()
        expect(stored!.lastActive).toBe(MIDNIGHT + 3_000)
    })
})

const OLD = () => Math.floor(Date.now() / 1000) - 3 * DAY
const KEY_A = encodeOkpEd25519Key({ x: new Uint8Array(32).fill(1) })
const KEY_B = encodeOkpEd25519Key({ x: new Uint8Array(32).fill(2) })

let counter = 0
async function registered(overrides: Partial<{ did: string; anchorKey: Uint8Array }> = {}) {
    const did = `did:plc:owner-touch-${(counter += 1)}`
    const lastActive = OLD()
    const locator = await new KVDirectory(testEnv).create(did, {
        did,
        anchorKey: KEY_A,
        lastActive,
        ...overrides,
    })
    const stub = testEnv.pmrs.get(testEnv.pmrs.idFromString(locator))
    return { did, stub, locator, lastActive, current: async () => (await stub.load())?.lastActive }
}

async function connect(stub: DurableObjectStub<PMRObject>): Promise<WebSocket> {
    const response = await stub.fetch("https://relay.example/pmr/v1/events", {
        headers: { Upgrade: "websocket" },
    })
    expect(response.status).toBe(101)
    const ws = response.webSocket!
    ws.binaryType = "arraybuffer"
    ws.accept()
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", (event) => {
            if (decodeFrame(new Uint8Array(event.data as ArrayBuffer)).type === "caughtUp") resolve()
        })
        ws.addEventListener("error", reject)
    })
    return ws
}

const attachments = (stub: DurableObjectStub<PMRObject>) =>
    inPMR(stub, (pmr) =>
        (pmr as unknown as { ctx: DurableObjectState }).ctx
            .getWebSockets()
            .map((ws) => ws.deserializeAttachment() as { anchorKey?: Uint8Array } | null)
    )

function ackFrame(key: string, messageId: string): Uint8Array {
    const header = encodeCose(new Map<string, CoseValue>([["op", 1], ["t", "#ack"]]))
    const body = encodeCose(new Map<string, CoseValue>([["k", key], ["id", messageId]]))
    return new Uint8Array([...header, ...body])
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("socket", () => {
    it("a bare DO upgrade does not touch", async () => {
        const r = await registered()
        await connect(r.stub)
        expect(await r.current()).toBe(r.lastActive)
    })

    it("upgrade binds the current anchorKey; no registration → no binding", async () => {
        const r = await registered()
        await connect(r.stub)
        const [bound] = await attachments(r.stub)
        expect([...bound!.anchorKey!]).toEqual([...KEY_A])

        const bare = testEnv.pmrs.get(testEnv.pmrs.newUniqueId())
        await connect(bare)
        expect(await attachments(bare)).toEqual([null])
    })

    it("an inbound frame (valid ack, malformed binary, string) touches via the bound key", async () => {
        const frames: Array<() => Uint8Array | string> = [
            () => ackFrame("did:plc:peer", "m1"),
            () => new Uint8Array([0xff, 0xff, 0xff]),
            () => "text",
        ]
        for (const frame of frames) {
            const r = await registered()
            const ws = await connect(r.stub)
            ws.send(frame())
            await expect.poll(async () => (await r.current())! > r.lastActive).toBe(true)
            expect(Math.abs((await r.current())! - Math.floor(Date.now() / 1000))).toBeLessThan(60)
        }
    })

    it("the bound key survives hibernation", async () => {
        // Real eviction is not driven here. What matters is that frames read
        // the key from the socket's attachment, never from instance memory:
        // rewrite the attachment and the same frame stops counting.
        const r = await registered()
        const ws = await connect(r.stub)
        await inPMR(r.stub, (pmr) =>
            (pmr as unknown as { ctx: DurableObjectState }).ctx
                .getWebSockets()[0]!
                .serializeAttachment({ anchorKey: KEY_B })
        )
        await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
        ws.send(ackFrame("did:plc:peer", "m1"))
        await expect.poll(() => inPMR(r.stub, (pmr) => pmr.list("did:plc:peer", 10))).toEqual([])
        expect(await r.current()).toBe(r.lastActive)
    })

    it("a frame whose bound key no longer matches does not touch", async () => {
        const r = await registered()
        await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
        const ws = await connect(r.stub)
        await r.stub.update({ anchorKey: KEY_B })
        ws.send(ackFrame("did:plc:peer", "m1"))
        // The touch precedes frame handling, so once the ack has landed the touch has been decided.
        await expect.poll(() => inPMR(r.stub, (pmr) => pmr.list("did:plc:peer", 10))).toEqual([])
        expect(await r.current()).toBe(r.lastActive)
    })

    it("a failing touch still processes the ack", async () => {
        const r = await registered()
        await inPMR(r.stub, (pmr) => {
            pmr.touchActive = async () => {
                throw new Error("touch failed")
            }
        })
        await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
        const ws = await connect(r.stub)
        ws.send(ackFrame("did:plc:peer", "m1"))
        await expect.poll(() => inPMR(r.stub, (pmr) => pmr.list("did:plc:peer", 10))).toEqual([])
    })

    it("a failed key bind (e.g. oversized attachment) still completes the upgrade, unbound", async () => {
        const r = await registered({ anchorKey: new Uint8Array(1_000_000).fill(3) })
        await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
        const ws = await connect(r.stub)
        expect(await attachments(r.stub)).toEqual([null])
        ws.send(ackFrame("did:plc:peer", "m1"))
        await expect.poll(() => inPMR(r.stub, (pmr) => pmr.list("did:plc:peer", 10))).toEqual([])
        expect(await r.current()).toBe(r.lastActive)
    })
})

describe("never touches", () => {
    async function untouched(act: (r: Awaited<ReturnType<typeof registered>>) => Promise<unknown>) {
        const r = await registered()
        await act(r)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(await r.current()).toBe(r.lastActive)
    }

    it("server sends: deliverLive, backlog drain, capabilities, summary nudge", async () => {
        await untouched(async (r) => {
            await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
            await connect(r.stub)
            await inPMR(r.stub, (pmr) =>
                pmr.deliverLive("did:plc:peer", { messageId: "m2", byteLength: 1 }, new Uint8Array([2]))
            )
            await r.stub.issueGrant("addr-nt", new Uint8Array(32), Math.floor(Date.now() / 1000) + 3600)
            await r.stub.invalidateGrant("addr-nt")
            await inPMR(r.stub, (pmr) => pmr.nudgeSummary())
        })
    })

    it("deliverPush, including the 404/410 subscription discard", async () => {
        for (const status of [201, 404, 410]) {
            await untouched(async (r) => {
                await inPMR(r.stub, (pmr) => {
                    const held = pmr as unknown as { env: PMREnv }
                    held.env = {
                        ...held.env,
                        VAPID_PUBLIC_KEY: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        VAPID_PRIVATE_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
                        VAPID_SUBJECT: "mailto:ops@relay.example",
                        PUSH_MAX_SEALED_BYTES: "2880",
                        PUSH_TTL_SECONDS: "86400",
                    }
                })
                await r.stub.update({
                    pushSubscription: {
                        endpoint: "https://push.example/sub/1",
                        contentKey: new Uint8Array(32).fill(1),
                        keyId: 1,
                    },
                })
                vi.stubGlobal("fetch", async () => new Response(null, { status }))
                vi.spyOn(console, "error").mockImplementation(() => {})
                await inPMR(r.stub, (pmr) =>
                    pmr.deliverPush("did:plc:peer", { messageId: "m1", byteLength: 5 }, new Uint8Array([1]))
                )
                const subscription = (await r.stub.load())!.pushSubscription
                expect(subscription === undefined).toBe(status !== 201)
            })
        }
    })

    it("alarm sweeps", async () => {
        await untouched((r) => inPMR(r.stub, (pmr) => pmr.alarm()))
    })

    it("monitor recheck and declaration-watch writes", async () => {
        await untouched(async (r) => {
            await r.stub.markMonitorConfirmed()
            await r.stub.writeWatchState(await r.stub.readWatchState())
            await r.stub.applyDeclarationOutcome("absent", Math.floor(Date.now() / 1000), "3k")
            await r.stub.syncBskyBlocks(new Set(["did:plc:blocked"]))
        })
    })

    it("pair put and grant put", async () => {
        await untouched(async (r) => {
            await r.stub.append("did:plc:peer", { messageId: "m1", byteLength: 1 }, new Uint8Array([1]), 0)
            await r.stub.appendToRequest("did:plc:other", { messageId: "m2", byteLength: 1 }, new Uint8Array([2]), 0)
            await r.stub.issueGrant("addr-gp", new Uint8Array(32), Math.floor(Date.now() / 1000) + 3600)
            await r.stub.appendPair(
                "did:plc:peer-evidence",
                { messageId: "m4", byteLength: 1 },
                new Uint8Array([4]),
                Math.floor(Date.now() / 1000),
                {
                    senderDID: "did:plc:peer-evidence",
                    anchorKey: new Uint8Array(32).fill(1),
                    declarationCID: "bafy-a",
                    revision: "3333333333333",
                    car: new Uint8Array([1]),
                    expiresAt: Math.floor(Date.now() / 1000) + 3600,
                }
            )
            await r.stub.append(grantMailboxKey("addr-gp"), { messageId: "m3", byteLength: 1 }, new Uint8Array([3]), 0)
        })
    })

    it("the core pair and grant put handlers", async () => {
        const directory = new KVDirectory(testEnv)
        await untouched(async (r) => {
            const now = Math.floor(Date.now() / 1000)
            const deps = {
                config: { limits: { messageMaxBytes: 1000, framingAllowanceBytes: 1024, messageExpirySeconds: 1000 } } as never,
                directory,
                store: (locator: string) => pmrStore(locator, testEnv),
                bodies: kvBodyStore(testEnv),
                defer: (work: Promise<unknown>) => void deferred.push(work),
            }
            const deferred: Promise<unknown>[] = []
            for (const sender of ["did:plc:peer-a", "did:plc:peer-b"] as const) {
                if (sender === "did:plc:peer-b") await r.stub.block(sender, now, "device")
                await ingestAuthenticatedPut(
                    {
                        recipientDID: r.did as never,
                        senderDID: sender,
                        declarationCID: "bafy",
                        payload: new Uint8Array([1, 2, 3]),
                        replayKey: new Uint8Array([9]),
                    },
                    deps,
                    now
                )
            }
            const authKey = new Uint8Array(32).fill(7)
            const address = "addr-handler"
            await r.stub.issueGrant(address, authKey, now + 3600)
            await directory.createGrantAddress(r.locator, address, authKey, now + 3600)
            const nonce = "grant-nonce"
            const message = new Uint8Array([4, 5, 6])
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message))
            const tag = computeGrantPutTag(authKey, address, new TextEncoder().encode(nonce), digest)
            const challenges = {
                mint: async () => {},
                consume: async () => `grantPut:${address}`,
            }
            const body = encodeCose(new Map<string, CoseValue>([["n", nonce], ["t", tag], ["m", message]]))
            const response = await handleGrantPut(
                new Request("https://relay.example/", { method: "POST", body }),
                address,
                { ...deps, challenges, store: deps.store },
                now
            )
            expect(response.status).toBe(202)
            await Promise.allSettled(deferred)
            expect((await r.stub.list(grantMailboxKey(address), 10)).length).toBe(1)
        })
    })

    it("census probe", async () => {
        const directory = new KVDirectory(testEnv)
        const r = await registered()
        expect(await directory.probeRegistration(r.did)).toEqual({ lastActive: r.lastActive })
        expect(await r.current()).toBe(r.lastActive)
    })
})
