/**
 * `snapshotRecordReader`: a verified read of one record from a third party's
 * snapshot, generic over collection and rkey (exercised here on a
 * non-declaration collection), with the 24 h direct CID check.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { RecordNotFoundError, SIGNING_KEY_TTL_MS } from "../src/atproto-fetch"
import {
    SNAPSHOT_MAX_AGE_MS,
    snapshotRecordReader,
    type RecordSnapshot,
    type StoredRecordSnapshot,
} from "../src/snapshot-read"
import { buildRepoCar, makeKey, type TestKey } from "./fixtures/repo-car"

const DID = "did:plc:alice1234567890123456789012"
const COLLECTION = "app.example.thing"
const RKEY = "rk1"
const PATH = `${COLLECTION}/${RKEY}`
const NOW = 10_000_000_000
const OLD = NOW - SNAPSHOT_MAX_AGE_MS - 1
const record = (n: number) => ({ $type: COLLECTION, n })

function setup(
    options: {
        key?: TestKey
        signWith?: TestKey
        commitDid?: string
        records?: Record<string, unknown>
        freshAtMs?: number
        noSnapshot?: boolean
        signingKey?: string | null
        fetchDirect?: (did: string, collection: string, rkey: string) => Promise<Uint8Array>
    } = {}
) {
    const key = options.key ?? makeKey()
    const repo = buildRepoCar({
        did: DID,
        key,
        signWith: options.signWith,
        commitDid: options.commitDid,
        records: options.records ?? { [PATH]: record(1) },
    })
    const snapshot: RecordSnapshot | null = options.noSnapshot
        ? null
        : { car: repo.car, freshAtMs: options.freshAtMs ?? NOW }
    const keysAsked: string[] = []
    const read = snapshotRecordReader({
        collection: COLLECTION,
        rkey: RKEY,
        getSnapshot: async () => snapshot,
        resolveSigningKey: async (did) => {
            keysAsked.push(did)
            return options.signingKey === undefined ? key.multikey : options.signingKey
        },
        nowMs: () => NOW,
        fetchDirect: options.fetchDirect ?? (async () => repo.car),
    })
    return { read, repo, key, keysAsked }
}

describe("snapshotRecordReader", () => {
    it("returns the record, its CID and rev, and the verified snapshot CAR byte for byte", async () => {
        const t = setup()
        const out = await t.read(DID)
        expect(out).toMatchObject({
            found: true,
            cid: t.repo.recordCids[PATH],
            rev: "3kaaaaaaaaaaa",
            record: { $type: COLLECTION, n: 1 },
        })
        if (!out.found) throw new Error("unreachable")
        expect(out.car).toBe(t.repo.car)
    })

    it("hands fetchDirect the reader's own collection and rkey", async () => {
        let car: Uint8Array = new Uint8Array()
        const direct = vi.fn(async (_d: string, _c: string, _r: string) => car)
        const t = setup({ freshAtMs: OLD, fetchDirect: direct })
        car = t.repo.car
        await t.read(DID)
        expect(direct).toHaveBeenCalledWith(DID, COLLECTION, RKEY)
    })

    it("no snapshot → found: false, without asking for a key or reading anything", async () => {
        const direct = vi.fn(async () => new Uint8Array())
        const t = setup({ noSnapshot: true, fetchDirect: direct })
        expect(await t.read(DID)).toMatchObject({ found: false })
        expect(t.keysAsked).toEqual([])
        expect(direct).not.toHaveBeenCalled()
    })

    it("a getSnapshot fault propagates rather than resolving found: false", async () => {
        const read = snapshotRecordReader({
            collection: COLLECTION,
            rkey: RKEY,
            getSnapshot: async () => {
                throw new Error("kv down")
            },
            resolveSigningKey: async () => "z",
            nowMs: () => NOW,
            fetchDirect: async () => new Uint8Array(),
        })
        await expect(read(DID)).rejects.toThrow("kv down")
    })

    it("no signing key, a wrong signer, a wrong DID, or no record at the path → found: false", async () => {
        expect(await setup({ signingKey: null }).read(DID)).toMatchObject({ found: false })
        expect(await setup({ signWith: makeKey() }).read(DID)).toMatchObject({ found: false })
        expect(await setup({ commitDid: "did:plc:other00000000000000000000" }).read(DID)).toMatchObject({ found: false })
        expect(
            await setup({ records: { "app.example.other/x": record(2) } }).read(DID)
        ).toMatchObject({ found: false })
    })

    describe("a snapshot older than SNAPSHOT_MAX_AGE_MS", () => {
        const sameKey = makeKey()
        const carWith = (n: number, signWith?: TestKey) =>
            buildRepoCar({
                did: DID,
                key: sameKey,
                signWith,
                rev: "3kbbbbbbbbbbb",
                records: { [PATH]: record(n) },
            })

        it("stands when the source's record CID is unchanged, and the source's CAR is never verified or adopted", async () => {
            // Same record, but signed by the wrong key: only the CID is compared.
            const direct = vi.fn(async () => carWith(1, makeKey()).car)
            const t = setup({ key: sameKey, freshAtMs: OLD, fetchDirect: direct })
            const out = await t.read(DID)
            expect(out).toMatchObject({ found: true, cid: t.repo.recordCids[PATH], rev: "3kaaaaaaaaaaa" })
            expect(direct).toHaveBeenCalledTimes(1)
        })

        it("remembers a definite answer, so repeated reads do not each read the PDS", async () => {
            const direct = vi.fn(async () => carWith(2).car)
            const t = setup({ key: sameKey, freshAtMs: OLD, fetchDirect: direct })
            await t.read(DID)
            await t.read(DID)
            expect(direct).toHaveBeenCalledTimes(1)
            const down = vi.fn(async () => {
                throw new Error("pds down")
            })
            const u = setup({ key: sameKey, freshAtMs: OLD, fetchDirect: down })
            await u.read(DID)
            await u.read(DID)
            expect(down).toHaveBeenCalledTimes(2)
        })

        it("re-reads once the remembered answer is older than SIGNING_KEY_TTL_MS", async () => {
            const repo = carWith(1)
            let now = NOW
            const direct = vi.fn(async () => repo.car)
            const read = snapshotRecordReader({
                collection: COLLECTION,
                rkey: RKEY,
                getSnapshot: async () => ({ car: repo.car, freshAtMs: OLD }),
                resolveSigningKey: async () => sameKey.multikey,
                nowMs: () => now,
                fetchDirect: direct,
            })
            await read(DID)
            now += SIGNING_KEY_TTL_MS - 1
            await read(DID)
            expect(direct).toHaveBeenCalledTimes(1)
            now += 1
            await read(DID)
            expect(direct).toHaveBeenCalledTimes(2)
        })

        it("is not read when the snapshot itself does not verify", async () => {
            const direct = vi.fn(async () => carWith(2).car)
            await setup({ freshAtMs: OLD, signingKey: makeKey().multikey, fetchDirect: direct }).read(DID)
            expect(direct).not.toHaveBeenCalled()
        })

        it("is not found when the source's record differs: the snapshot is out of date, and the source's value is not adopted", async () => {
            const t = setup({ key: sameKey, freshAtMs: OLD, fetchDirect: async () => carWith(2).car })
            expect(await t.read(DID)).toMatchObject({ found: false })
        })

        it("is not found when the source says the record is gone", async () => {
            const absent = buildRepoCar({
                did: DID,
                key: sameKey,
                records: { "app.example.other/x": record(9) },
            })
            expect(
                await setup({ key: sameKey, freshAtMs: OLD, fetchDirect: async () => absent.car }).read(DID)
            ).toMatchObject({ found: false })
            const gone = setup({
                key: sameKey,
                freshAtMs: OLD,
                fetchDirect: async () => {
                    throw new RecordNotFoundError("deactivated", false)
                },
            })
            expect(await gone.read(DID)).toMatchObject({ found: false })
        })

        it("falls back to the older snapshot when the direct read fails or is malformed", async () => {
            for (const fetchDirect of [
                async () => {
                    throw new Error("pds down")
                },
                async () => Uint8Array.of(1, 2, 3),
            ]) {
                const t = setup({ key: sameKey, freshAtMs: OLD, fetchDirect })
                expect(await t.read(DID)).toMatchObject({ found: true, cid: t.repo.recordCids[PATH] })
            }
        })

        it("is not read directly at exactly the age bound, and a fresh one never is", async () => {
            const direct = vi.fn(async () => carWith(2).car)
            await setup({ key: sameKey, freshAtMs: NOW - SNAPSHOT_MAX_AGE_MS, fetchDirect: direct }).read(DID)
            await setup({ key: sameKey, freshAtMs: NOW, fetchDirect: direct }).read(DID)
            expect(direct).not.toHaveBeenCalled()
        })
    })
})

describe("StoredRecordSnapshot", () => {
    it("carries rev and cid, nullable for legacy entries", () => {
        expectTypeOf<StoredRecordSnapshot["rev"]>().toEqualTypeOf<string | null>()
        expectTypeOf<StoredRecordSnapshot["cid"]>().toEqualTypeOf<string | null>()
        // @ts-expect-error rev and cid are required, not optional
        const legacy: StoredRecordSnapshot = { car: new Uint8Array(), freshAtMs: 0, verifiedWith: null }
        expect(legacy.freshAtMs).toBe(0)
    })
})
