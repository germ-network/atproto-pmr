/**
 * Which traffic records owner activity (D-24) and which never does.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
    authenticateOwner,
    encodeBinding,
    encodeOkpEd25519Key,
    signRequest,
    type ChallengeStore,
} from "@germ-network/atproto-pmr-core"
import { KVDirectory, pmrStore } from "../src/directory"
import type { PMREnv } from "../src/env"
import type { PMRObject } from "../src/pmr-object"

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

describe("socket", () => {
    it.todo("a bare DO upgrade does not touch")
    it.todo("upgrade binds the current anchorKey; no registration → no binding")
    it.todo("an inbound frame (valid ack, malformed binary, string) touches via the bound key")
    it.todo("the bound key survives hibernation")
    it.todo("a frame whose bound key no longer matches does not touch")
    it.todo("a failing touch still processes the ack")
    it.todo("a failed key bind (e.g. oversized attachment) still completes the upgrade, unbound")
})

describe("never touches", () => {
    it.todo("server sends: deliverLive, backlog drain, capabilities, summary nudge")
    it.todo("deliverPush, including the 404/410 subscription discard")
    it.todo("alarm sweeps")
    it.todo("monitor recheck and declaration-watch writes")
    it.todo("pair put and grant put")
    it.todo("census probe")
})
