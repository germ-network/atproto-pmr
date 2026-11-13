/**
 * Owner activity at authentication: `authenticateOwner` touches the exact
 * authenticated registration once per UTC day, whatever the handler does next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authenticateOwner } from "../src/owner/authenticate"
import { handleBlocksList, handleBlockSet, handleGrantDelete } from "../src/owner/endpoints"
import type { PMRStore } from "../src/storage"
import { T0, ownerWorld } from "./owner-harness"

const NEXT_DAY = T0 + 86_400

type Touch = [number, Uint8Array]

function recording(extra: Partial<PMRStore> = {}) {
    const touches: Touch[] = []
    const stub = {
        touchActive: async (now: number, key: Uint8Array) => void touches.push([now, key]),
        ...extra,
    } as Partial<PMRStore>
    return { touches, stub }
}

let consoleSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {})
    )
})
afterEach(() => vi.restoreAllMocks())

describe("authenticateOwner touch", () => {
    it("success touches once with the stored anchorKey blob", async () => {
        const { touches, stub } = recording()
        const w = await ownerWorld(stub, { nowSeconds: NEXT_DAY })
        const stored = await w.deps.store("loc").load()
        const auth = await authenticateOwner(await w.request("/pmr/v1/registration"), null, w.deps)
        expect(auth.authenticated).toBe(true)
        expect(touches).toHaveLength(1)
        expect(touches[0]![0]).toBe(NEXT_DAY)
        expect([...touches[0]![1]]).toEqual([...stored!.anchorKey])
    })

    it("success on a day already recorded makes no touchActive call", async () => {
        const { touches, stub } = recording()
        const w = await ownerWorld(stub, { nowSeconds: T0 + 3_600 })
        const auth = await authenticateOwner(await w.request("/pmr/v1/registration"), null, w.deps)
        expect(auth.authenticated).toBe(true)
        expect(touches).toEqual([])
    })

    it("each failed-auth reason never touches", async () => {
        const { touches, stub } = recording()
        const w = await ownerWorld(stub, { nowSeconds: NEXT_DAY })
        const path = "/pmr/v1/registration"

        const unsigned = new Request(`https://relay.example${path}`)
        const replayed = await w.request(path)
        const replay = () => new Request(replayed.url, { headers: replayed.headers })
        const signedForGet = await w.request(path)
        const wrongMethod = new Request(signedForGet.url, { method: "POST", headers: signedForGet.headers })
        const malformed = new Request(replayed.url, { headers: { "signature-input": "not a structured field (" } })
        const failures = [
            unsigned,
            malformed,
            replay(), // first redeem succeeds below; this one then replays
            wrongMethod,
        ]
        // Spend the replayed challenge once before replaying it.
        await authenticateOwner(replay(), null, w.deps)
        touches.length = 0

        const reasons: string[] = []
        for (const request of failures) {
            const out = await authenticateOwner(request, null, w.deps)
            expect(out.authenticated).toBe(false)
            if (!out.authenticated) reasons.push(out.reason)
        }
        // The wrong-method request is the one that reaches signature verification.
        expect(reasons[3]).not.toMatch(/redeemable|no registration|unsigned|nonce|malformed/)

        const noRoute = await ownerWorld(stub, { nowSeconds: NEXT_DAY, resolveLocator: async () => null })
        expect(
            (await authenticateOwner(await noRoute.request(path), null, noRoute.deps)).authenticated
        ).toBe(false)

        const noRecord = await ownerWorld(stub, { nowSeconds: NEXT_DAY })
        const emptyDeps = { ...noRecord.deps, store: () => ({ ...stub, load: async () => null }) as unknown as PMRStore }
        expect(
            (await authenticateOwner(await noRecord.request(path), null, emptyDeps)).authenticated
        ).toBe(false)

        expect(touches).toEqual([])
    })

    it("an authed() handler that answers 400, 404 or throws after auth has still touched", async () => {
        const { touches, stub } = recording({
            getGrant: async () => null,
            listBlocked: async () => {
                throw new Error("boom")
            },
        })
        const w = await ownerWorld(stub, { nowSeconds: NEXT_DAY })

        const badDid = await handleBlockSet(await w.request("/pmr/v1/blocks/x", "PUT"), "not-a-did", true, w.deps)
        expect(badDid.status).toBe(400)
        expect(touches).toHaveLength(1)

        const missing = await handleGrantDelete(await w.request("/pmr/v1/grants/a", "DELETE"), "a", w.deps)
        expect(missing.status).toBe(404)
        expect(touches).toHaveLength(2)

        await expect(handleBlocksList(await w.request("/pmr/v1/blocks"), w.deps)).rejects.toThrow("boom")
        expect(touches).toHaveLength(3)
    })

    it("a throwing touchActive leaves the auth result unchanged and the console silent", async () => {
        const { stub } = recording({
            touchActive: async () => {
                throw new Error("did:plc:owner0000000000000000000")
            },
        })
        const w = await ownerWorld(stub, { nowSeconds: NEXT_DAY })
        const auth = await authenticateOwner(await w.request("/pmr/v1/registration"), null, w.deps)
        expect(auth).toMatchObject({ authenticated: true, did: "did:plc:owner0000000000000000000", locator: "loc" })
        expect(consoleSpies.flatMap((s) => s.mock.calls)).toEqual([])
    })

    it("touches the authenticated locator's store, never a re-resolved one", async () => {
        const touched: string[] = []
        const { stub } = recording()
        let resolves = 0
        const base = await ownerWorld(stub, { nowSeconds: NEXT_DAY })
        const registration = await base.deps.store("loc").load()
        const deps = {
            ...base.deps,
            resolveLocator: async () => `loc-${(resolves += 1)}`,
            store: (locator: string) =>
                ({
                    load: async () => registration,
                    touchActive: async () => void touched.push(locator),
                }) as unknown as PMRStore,
        }
        const auth = await authenticateOwner(await base.request("/pmr/v1/registration"), null, deps)
        expect(auth.authenticated).toBe(true)
        expect(resolves).toBe(1)
        expect(touched).toEqual(["loc-1"])
    })
})
