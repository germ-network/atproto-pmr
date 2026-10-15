/**
 * A record read serves the rev and CID ingest verified, and never a snapshot
 * signed under a key the DID has rotated away from.
 */
import { describe, expect, it } from "vitest"
import { decodeRecordReadResponse, handleRecordRead, type RecordReadDeps } from "../src/device-read"
import type { ReadSigningKey } from "../src/read-signing-key"
import type { StoredRecordSnapshot } from "../src/snapshot-read"
import { buildRepoCar, makeKey } from "./fixtures/repo-car"

const DID = "did:plc:alice1234567890123456789012"
const COLLECTION = "app.example.thing"
const RKEY = "rk1"
const PATH_OK = `/pmr/v1/records/${DID}/${COLLECTION}/${RKEY}`
const NOW = 10_000_000_000

function setup(
    options: {
        snapshot?: Partial<StoredRecordSnapshot>
        serves?: boolean
        held?: boolean
        key?: ReadSigningKey
    } = {}
) {
    const key = makeKey()
    const repo = buildRepoCar({
        did: DID,
        key,
        rev: "3kccccccccccc",
        records: { [`${COLLECTION}/${RKEY}`]: { $type: COLLECTION, n: 1 } },
    })
    const stored: StoredRecordSnapshot = {
        car: repo.car,
        freshAtMs: NOW,
        verifiedWith: key.multikey,
        rev: "3kccccccccccc",
        cid: repo.recordCids[`${COLLECTION}/${RKEY}`]!,
        ...options.snapshot,
    }
    const keyReads: string[][] = []
    const deps: RecordReadDeps = {
        records: { get: async () => (options.held === false ? null : stored) },
        serves: async () => options.serves ?? true,
        watched: [{ collection: COLLECTION, rkey: RKEY }],
        signingKeys: {
            keysFor: async (dids) => {
                keyReads.push([...dids])
                const resolved = options.key ?? { kind: "trusted", key: key.multikey }
                return new Map(dids.map((d) => [d, resolved]))
            },
        },
        nowMs: () => NOW,
        requestRecheck: async () => {},
        waitUntil: () => {},
    }
    return { deps, repo, key, keyReads }
}

async function read(path: string, deps: RecordReadDeps) {
    const res = await handleRecordRead(new Request(`https://pmr.example${path}`), deps)
    return decodeRecordReadResponse(new Uint8Array(await res.arrayBuffer()))
}

describe("handleRecordRead verdict", () => {
    it("rev and cid come from the snapshot's verified metadata, not a parse of the CAR", async () => {
        const { deps, repo } = setup({ snapshot: { rev: "3kzzzzzzzzzzz", cid: "bafyreimetadata" } })
        expect(await read(PATH_OK, deps)).toEqual({
            found: true,
            car: repo.car,
            rev: "3kzzzzzzzzzzz",
            cid: "bafyreimetadata",
            freshAtMs: NOW,
        })
    })

    it("a verified entry with a null rev or cid falls back to the parse", async () => {
        for (const missing of [{ rev: null }, { cid: null }, { rev: null, cid: null }]) {
            const { deps, repo } = setup({
                snapshot: { rev: "3kzzzzzzzzzzz", cid: "bafyreimetadata", ...missing },
            })
            expect(await read(PATH_OK, deps)).toMatchObject({
                found: true,
                rev: "3kccccccccccc",
                cid: repo.recordCids[`${COLLECTION}/${RKEY}`],
            })
        }
    })

    it("a snapshot whose verifiedWith is not the trusted current key reads unverifiable", async () => {
        const { deps, repo } = setup({ key: { kind: "trusted", key: "zRotatedTo" } })
        const res = await handleRecordRead(new Request(`https://pmr.example${PATH_OK}`), deps)
        const bytes = new Uint8Array(await res.arrayBuffer())
        expect(decodeRecordReadResponse(bytes)).toMatchObject({ found: false, code: "unverifiable" })
        expect(indexOf(bytes, repo.car)).toBe(-1)
    })

    it("a did:plc DID with no trusted current key reads unverifiable", async () => {
        const { deps } = setup({ key: { kind: "unknown" } })
        expect(await read(PATH_OK, deps)).toMatchObject({ found: false, code: "unverifiable" })
    })

    it("a did:web DID is served on its ingest verdict", async () => {
        const { deps } = setup({ key: { kind: "unchecked" } })
        expect(await read(PATH_OK, deps)).toMatchObject({ found: true })
    })

    it("a DID the key reader returns nothing for reads unverifiable", async () => {
        const { deps } = setup()
        deps.signingKeys = { keysFor: async () => new Map() }
        expect(await read(PATH_OK, deps)).toMatchObject({ found: false, code: "unverifiable" })
    })

    it("the key is read only for a DID that is served and held", async () => {
        const unserved = setup({ serves: false })
        expect(await read(PATH_OK, unserved.deps)).toMatchObject({ code: "not-watched" })
        const unheld = setup({ held: false })
        expect(await read(PATH_OK, unheld.deps)).toMatchObject({ code: "not-held" })
        const unverified = setup({ snapshot: { verifiedWith: null } })
        expect(await read(PATH_OK, unverified.deps)).toMatchObject({ code: "unverifiable" })
        const unwatched = setup()
        expect(
            await read(`/pmr/v1/records/${DID}/${COLLECTION}/other`, unwatched.deps)
        ).toMatchObject({ code: "not-watched" })
        for (const s of [unserved, unheld, unverified, unwatched]) expect(s.keyReads).toEqual([])
        const served = setup()
        await read(PATH_OK, served.deps)
        expect(served.keyReads).toEqual([[DID]])
    })
})

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
        return i
    }
    return -1
}
