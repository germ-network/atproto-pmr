/**
 * `directDeclarationResolver`: a sender's declaration read straight from its
 * PDS, verified as strictly as a monitor snapshot, under a bounded time.
 */
import { describe, expect, it, vi } from "vitest"
import { fetchRecordProofCar } from "../src/atproto-fetch"
import { directDeclarationResolver } from "../src/declaration"
import { buildRepoCar, makeKey, type TestKey } from "./fixtures/repo-car"

const DID = "did:plc:alice1234567890123456789012"
const DECL_PATH = "com.germnetwork.declaration/self"
const ANCHOR = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const declaration = (currentKey: unknown) => ({
    $type: "com.germnetwork.declaration",
    version: "1.2.0",
    currentKey,
})

function setup(
    options: {
        commitDid?: string
        signWith?: TestKey
        records?: Record<string, unknown>
        record?: unknown
        signingKey?: string | null
        timeoutMs?: number
        fetchProofCar?: (
            did: string,
            collection: string,
            rkey: string,
            signal: AbortSignal
        ) => Promise<Uint8Array>
        resolveSigningKey?: (did: string) => Promise<string | null>
    } = {}
) {
    const key = makeKey()
    const repo = buildRepoCar({
        did: DID,
        key,
        rev: "3kbbbbbbbbbbb",
        commitDid: options.commitDid,
        signWith: options.signWith,
        records: options.records ?? {
            [DECL_PATH]: options.record ?? declaration(Uint8Array.of(3, ...ANCHOR)),
        },
    })
    const fetchProofCar = vi.fn(options.fetchProofCar ?? (async () => repo.car))
    const resolveSigningKey = vi.fn(
        options.resolveSigningKey ??
            (async () => (options.signingKey === undefined ? key.multikey : options.signingKey))
    )
    const resolve = directDeclarationResolver({
        fetchProofCar,
        resolveSigningKey,
        timeoutMs: options.timeoutMs ?? 1_000,
    })
    return { resolve, repo, fetchProofCar, resolveSigningKey }
}

/** Never settles; rejects when the signal aborts, as `fetch` does. */
function hangsUntilAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
}

describe("direct declaration read", () => {
    it("a proof CAR signed under the DID's #atproto key yields the anchor key, record CID, commit rev and the CAR", async () => {
        const t = setup()
        const out = await t.resolve(DID)
        expect(out).toMatchObject({
            found: true,
            declarationCID: t.repo.recordCids[DECL_PATH],
            revision: "3kbbbbbbbbbbb",
        })
        if (!out.found) throw new Error("unreachable")
        expect(out.evidenceCAR).toBe(t.repo.car)
        expect(out.anchorKey.x).toEqual(ANCHOR)
        expect(t.fetchProofCar).toHaveBeenCalledWith(
            DID,
            "com.germnetwork.declaration",
            "self",
            expect.any(AbortSignal)
        )
    })

    it("a CAR whose commit signature fails under the DID's #atproto key is found: false", async () => {
        const t = setup({ signWith: makeKey() })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
    })

    it("a CAR whose commit names another DID is found: false", async () => {
        const t = setup({ commitDid: "did:plc:other00000000000000000000" })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
    })

    it("a CAR proving the declaration absent is found: false", async () => {
        const t = setup({ records: { "app.bsky.actor.profile/self": { displayName: "a" } } })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
    })

    it("a declaration without readable currentKey bytes is found: false", async () => {
        for (const record of [
            { $type: "com.germnetwork.declaration", version: "1.2.0" },
            declaration("text"),
            declaration(Uint8Array.of(2, ...ANCHOR)),
            declaration(Uint8Array.of(3, ...ANCHOR.subarray(1))),
        ]) {
            expect(await setup({ record }).resolve(DID)).toMatchObject({ found: false })
        }
    })

    it("no #atproto signing key for the DID is found: false without fetching the CAR", async () => {
        const t = setup({ signingKey: null })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
        expect(t.fetchProofCar).not.toHaveBeenCalled()
    })

    it("a PDS slower than timeoutMs is found: false and the fetch's signal is aborted", async () => {
        let seen: AbortSignal | undefined
        const t = setup({
            timeoutMs: 30,
            fetchProofCar: (_d, _c, _r, signal) => {
                seen = signal
                return hangsUntilAborted(signal)
            },
        })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
        expect(seen?.aborted).toBe(true)
    })

    it("a signing-key resolution slower than timeoutMs is found: false: one deadline bounds the whole read", async () => {
        const t = setup({
            timeoutMs: 30,
            resolveSigningKey: () => new Promise(() => {}),
        })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
        expect(t.fetchProofCar).not.toHaveBeenCalled()
    })

    it("a rejected fetch is found: false rather than a thrown error", async () => {
        const t = setup({
            fetchProofCar: async () => {
                throw new Error("connection refused")
            },
        })
        expect(await t.resolve(DID)).toMatchObject({ found: false })
        const keyFails = setup({
            resolveSigningKey: async () => {
                throw new Error("directory down")
            },
        })
        expect(await keyFails.resolve(DID)).toMatchObject({ found: false })
    })

    it("fetchRecordProofCar rejects once its signal aborts, during PDS resolution or the record fetch", async () => {
        const hang = ((_url: unknown, init?: RequestInit) =>
            hangsUntilAborted(init!.signal!)) as typeof fetch

        const duringResolution = new AbortController()
        const resolving = fetchRecordProofCar(
            DID,
            "com.germnetwork.declaration",
            "self",
            hang,
            duringResolution.signal
        )
        duringResolution.abort(new Error("caller gave up"))
        await expect(resolving).rejects.toThrow("caller gave up")

        const calls: string[] = []
        const pdsThenHang = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(input.toString())
            if (calls.length === 1) {
                return new Response(
                    JSON.stringify({
                        id: DID,
                        service: [
                            {
                                id: "#atproto_pds",
                                type: "AtprotoPersonalDataServer",
                                serviceEndpoint: "https://pds.example",
                            },
                        ],
                    }),
                    { status: 200 }
                )
            }
            return hangsUntilAborted(init!.signal!)
        }) as typeof fetch
        const duringRecord = new AbortController()
        const fetching = fetchRecordProofCar(
            DID,
            "com.germnetwork.declaration",
            "self",
            pdsThenHang,
            duringRecord.signal
        )
        await vi.waitFor(() => expect(calls).toHaveLength(2))
        duringRecord.abort(new Error("caller gave up"))
        await expect(fetching).rejects.toThrow("caller gave up")
        expect(calls[1]).toContain("https://pds.example/xrpc/com.atproto.sync.getRecord")
    })
})
