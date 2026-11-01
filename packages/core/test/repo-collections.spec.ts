/** One getRepo pass verifying several collections at once. */
import { describe, expect, it } from "vitest"
import {
    RepoCollectionError,
    verifyRepoCollection,
    verifyRepoCollections,
    type RepoCollectionsExpectation,
} from "../src/repo-collection"
import {
    buildRepoCar,
    cidString,
    encodeCar,
    type BuiltRepo,
} from "./fixtures/repo-car"

const DID = "did:plc:alice"
const FOLLOW = "app.bsky.graph.follow"
const BLOCK = "app.bsky.graph.block"
const POST = "app.bsky.feed.post"

function edgeRecords(follows: number, blocks: number, posts = 0): Record<string, unknown> {
    const records: Record<string, unknown> = {}
    const key = (n: number) => String(n).padStart(4, "0")
    for (let i = 0; i < follows; i++) {
        records[`${FOLLOW}/f${key(i)}`] = { $type: FOLLOW, subject: `did:plc:f${i}` }
    }
    for (let i = 0; i < blocks; i++) {
        records[`${BLOCK}/b${key(i)}`] = { $type: BLOCK, subject: `did:plc:b${i}` }
    }
    for (let i = 0; i < posts; i++) {
        records[`${POST}/p${key(i)}`] = { $type: POST, text: `post ${i}` }
    }
    return records
}

function expectation(
    repo: BuiltRepo,
    overrides: Partial<RepoCollectionsExpectation> = {}
): RepoCollectionsExpectation {
    return {
        did: DID,
        signingKey: repo.key.multikey,
        collections: [FOLLOW, BLOCK],
        maxBytes: 10_000_000,
        maxNodes: 10_000,
        ...overrides,
    }
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => null,
        (e: unknown) => e
    )
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
    const error = await rejection(promise)
    expect(error).toBeInstanceOf(RepoCollectionError)
    return (error as RepoCollectionError).code
}

describe("verifyRepoCollections", () => {
    it("returns each requested collection's records at the signed rev from one pass of the CAR", async () => {
        const repo = buildRepoCar({
            did: DID,
            rev: "3krevaaaaaaaa",
            records: edgeRecords(120, 70, 50),
        })
        let pulls = 0
        async function* counted(): AsyncGenerator<Uint8Array> {
            for await (const chunk of chunked(repo.car, 997)) {
                pulls++
                yield chunk
            }
        }
        const result = await verifyRepoCollections(counted(), expectation(repo))
        expect(pulls).toBe(Math.ceil(repo.car.length / 997))
        expect(result.rev).toBe("3krevaaaaaaaa")
        for (const [collection, count] of [
            [FOLLOW, 120],
            [BLOCK, 70],
        ] as const) {
            const expected = Object.entries(repo.recordCids)
                .filter(([path]) => path.startsWith(`${collection}/`))
                .map(([path, cid]) => ({ rkey: path.slice(collection.length + 1), cid }))
            const got = result.records.get(collection)!
            expect(got.map(({ rkey, cid }) => ({ rkey, cid }))).toEqual(expected)
            expect(got).toHaveLength(count)
        }
        expect(result.records.has(POST)).toBe(false)
        expect(result.records.get(BLOCK)![3]!.record).toEqual({
            $type: BLOCK,
            subject: "did:plc:b3",
        })
    })

    it("returns an empty list for a requested collection the repo has no records of", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(5, 0, 5) })
        const result = await verifyRepoCollections(chunked(repo.car, 512), expectation(repo))
        expect(result.records.get(BLOCK)).toEqual([])
        expect(result.records.get(FOLLOW)).toHaveLength(5)
    })

    it("refuses with record-cap-exceeded when any one collection passes its own cap", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(10, 10) })
        const capped = (follows: number, blocks: number) =>
            verifyRepoCollections(
                chunked(repo.car, 512),
                expectation(repo, { maxRecords: { [FOLLOW]: follows, [BLOCK]: blocks } })
            )
        await expect(capped(10, 10)).resolves.toBeDefined()
        expect(await codeOf(capped(9, 10))).toBe("record-cap-exceeded")
        expect(await codeOf(capped(10, 9))).toBe("record-cap-exceeded")
    })

    it("leaves a collection without a cap unbounded while another is capped", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(30, 3) })
        const result = await verifyRepoCollections(
            chunked(repo.car, 512),
            expectation(repo, { maxRecords: { [BLOCK]: 3 } })
        )
        expect(result.records.get(FOLLOW)).toHaveLength(30)
        expect(
            await codeOf(
                verifyRepoCollections(
                    chunked(repo.car, 512),
                    expectation(repo, { maxRecords: { [BLOCK]: 2 } })
                )
            )
        ).toBe("record-cap-exceeded")
    })

    it("applies maxBytes and maxNodes to the pass as a whole", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(60, 60) })
        expect(
            await codeOf(
                verifyRepoCollections(
                    chunked(repo.car, 512),
                    expectation(repo, { maxBytes: repo.car.length - 1 })
                )
            )
        ).toBe("byte-cap-exceeded")
        expect(
            await codeOf(
                verifyRepoCollections(
                    chunked(repo.car, 512),
                    expectation(repo, { maxNodes: 1 })
                )
            )
        ).toBe("node-cap-exceeded")
        await expect(
            verifyRepoCollections(
                chunked(repo.car, 512),
                expectation(repo, { maxBytes: repo.car.length })
            )
        ).resolves.toBeDefined()
    })

    it("refuses a record of one requested collection whose block the CAR omits (block-missing)", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(5, 5) })
        const victim = repo.recordCids[`${BLOCK}/b0002`]!
        const omitted = encodeCar(
            repo.root,
            repo.blocks.filter((b) => cidString(b.cid) !== victim)
        )
        expect(
            await codeOf(verifyRepoCollections(chunked(omitted, 512), expectation(repo)))
        ).toBe("block-missing")
    })

    it("refuses an empty or duplicated collections list", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(2, 2) })
        for (const collections of [[], [FOLLOW, FOLLOW]]) {
            expect(
                await rejection(
                    verifyRepoCollections(
                        chunked(repo.car, 512),
                        expectation(repo, { collections })
                    )
                )
            ).toBeInstanceOf(RangeError)
        }
    })

    it("refuses a record under one collection's key whose $type is another requested collection", async () => {
        const repo = buildRepoCar({
            did: DID,
            records: {
                ...edgeRecords(2, 2),
                [`${FOLLOW}/f9999`]: { $type: BLOCK, subject: "did:plc:x" },
            },
        })
        expect(
            await codeOf(verifyRepoCollections(chunked(repo.car, 512), expectation(repo)))
        ).toBe("block-missing")
    })

    it("walks each collection's key range on its own, so a shared root is not refused as revisited", async () => {
        const repo = buildRepoCar({ did: DID, records: edgeRecords(1, 1) })
        const result = await verifyRepoCollections(chunked(repo.car, 512), expectation(repo))
        expect(result.records.get(FOLLOW)).toHaveLength(1)
        expect(result.records.get(BLOCK)).toHaveLength(1)
    })

    it("verifyRepoCollection keeps its single-collection results and errors", async () => {
        const repo = buildRepoCar({ did: DID, rev: "3ksingleaaaaa", records: edgeRecords(8, 6) })
        const single = await verifyRepoCollection(chunked(repo.car, 512), {
            did: DID,
            signingKey: repo.key.multikey,
            collection: BLOCK,
            maxBytes: 10_000_000,
            maxNodes: 10_000,
        })
        const multi = await verifyRepoCollections(
            chunked(repo.car, 512),
            expectation(repo, { collections: [BLOCK] })
        )
        expect(single).toEqual({ rev: "3ksingleaaaaa", records: multi.records.get(BLOCK) })
        expect(single.records).toHaveLength(6)
        expect(
            await codeOf(
                verifyRepoCollection(chunked(repo.car, 512), {
                    did: DID,
                    signingKey: repo.key.multikey,
                    collection: BLOCK,
                    maxBytes: 10_000_000,
                    maxNodes: 10_000,
                    maxRecords: 5,
                })
            )
        ).toBe("record-cap-exceeded")
    })

    it("charges a record block with no $type against every requested collection's cap", async () => {
        const repo = buildRepoCar({
            did: DID,
            records: {
                ...edgeRecords(2, 2),
                "app.bsky.other/untyped": { subject: "did:plc:u" },
            },
        })
        const run = (follows: number, blocks: number) =>
            verifyRepoCollections(
                chunked(repo.car, 512),
                expectation(repo, { maxRecords: { [FOLLOW]: follows, [BLOCK]: blocks } })
            )
        await expect(run(3, 3)).resolves.toBeDefined()
        expect(await codeOf(run(2, 3))).toBe("record-cap-exceeded")
        expect(await codeOf(run(3, 2))).toBe("record-cap-exceeded")
    })
})
