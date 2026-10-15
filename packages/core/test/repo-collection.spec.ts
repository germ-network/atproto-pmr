/**
 * `verifyRepoCollection`: a whole-repo CAR yields a collection's records only
 * under the DID document's signing key, with every record the signed tree
 * holds in that collection and nothing else.
 */
import { describe, expect, it } from "vitest"
import {
    RepoCollectionError,
    verifyRepoCollection,
    type RepoCollectionExpectation,
} from "../src/repo-collection"
import {
    buildRepoCar,
    Link,
    cidOf,
    cidString,
    encodeCar,
    encodeDagCbor,
    makeKey,
    sign,
    type Block,
    type BuiltRepo,
} from "./fixtures/repo-car"

const DID = "did:plc:alice"
const FOLLOW = "app.bsky.graph.follow"
const POST = "app.bsky.feed.post"

function follow(subject: string): unknown {
    return { $type: FOLLOW, subject, createdAt: "2026-01-01T00:00:00Z" }
}

function mixedRecords(follows: number, posts: number): Record<string, unknown> {
    const records: Record<string, unknown> = {}
    for (let i = 0; i < follows; i++) {
        records[`${FOLLOW}/f${String(i).padStart(4, "0")}`] = follow(
            `did:plc:subject${i}`
        )
    }
    for (let i = 0; i < posts; i++) {
        records[`${POST}/p${String(i).padStart(4, "0")}`] = {
            $type: POST,
            text: `post ${i}`,
        }
    }
    return records
}

function expectation(
    repo: BuiltRepo,
    overrides: Partial<RepoCollectionExpectation> = {}
): RepoCollectionExpectation {
    return {
        did: DID,
        signingKey: repo.key.multikey,
        collection: FOLLOW,
        maxBytes: 10_000_000,
        maxNodes: 10_000,
        ...overrides,
    }
}

async function* chunked(
    bytes: Uint8Array,
    size: number
): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, i + size)
    }
}

async function rejection(promise: Promise<unknown>): Promise<RepoCollectionError> {
    const error = await promise.then(
        () => null,
        (e: unknown) => e
    )
    expect(error).toBeInstanceOf(RepoCollectionError)
    return error as RepoCollectionError
}

describe("verifyRepoCollection", () => {
    it("returns every follow in the signed tree and nothing else", async () => {
        const repo = buildRepoCar({
            did: DID,
            rev: "3krevaaaaaaaa",
            records: {
                ...mixedRecords(120, 80),
                "app.bsky.actor.profile/self": {
                    $type: "app.bsky.actor.profile",
                    displayName: "Alice",
                },
                "app.bsky.graph.followgate/x": { $type: "app.bsky.graph.followgate" },
                "app.bsky.graph.listitem/l1": { $type: "app.bsky.graph.listitem" },
                "app.bsky.graph.block/b1": {
                    $type: "app.bsky.graph.block",
                    subject: "did:plc:blocked",
                },
            },
        })

        const result = await verifyRepoCollection(
            chunked(repo.car, 997),
            expectation(repo)
        )

        expect(result.rev).toBe("3krevaaaaaaaa")
        const expected = Object.entries(repo.recordCids)
            .filter(([path]) => path.startsWith(`${FOLLOW}/`))
            .map(([path, cid]) => ({
                rkey: path.slice(FOLLOW.length + 1),
                cid,
            }))
        expect(
            result.records.map(({ rkey, cid }) => ({ rkey, cid }))
        ).toEqual(expected)
        expect(result.records).toHaveLength(120)
        expect(result.records[7]!.record).toEqual(follow("did:plc:subject7"))
    })

    it("rejects a bad commit signature", async () => {
        const repo = buildRepoCar({
            did: DID,
            records: mixedRecords(5, 5),
            signWith: makeKey(),
        })
        const error = await rejection(
            verifyRepoCollection(chunked(repo.car, 512), expectation(repo))
        )
        expect(error.code).toBe("signature-invalid")
    })

    it("rejects a kept block whose bytes don't hash to its CID", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(5, 5) })
        const victimPath = `${FOLLOW}/f0002`
        const victimCid = repo.recordCids[victimPath]!
        const blocks: Block[] = repo.blocks.map((block) =>
            cidString(block.cid) === victimCid
                ? { cid: block.cid, data: encodeDagCbor(follow("did:plc:evil")) }
                : block
        )
        const car = encodeCar(repo.root, blocks)
        const error = await rejection(
            verifyRepoCollection(chunked(car, 512), expectation(repo))
        )
        expect(error.code).toBe("block-cid-mismatch")
    })

    it("rejects a tampered MST node", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(60, 40) })
        const root = repo.blocks[repo.blocks.length - 1]!
        const blocks: Block[] = [
            ...repo.blocks.slice(0, -1),
            { cid: root.cid, data: encodeDagCbor({ l: null, e: [] }) },
        ]
        const error = await rejection(
            verifyRepoCollection(
                chunked(encodeCar(repo.root, blocks), 512),
                expectation(repo)
            )
        )
        expect(error.code).toBe("block-cid-mismatch")
    })

    it("rejects a commit for a different DID", async () => {
        const repo = buildRepoCar({
            did: DID,
            commitDid: "did:plc:mallory",
            records: mixedRecords(5, 5),
        })
        const error = await rejection(
            verifyRepoCollection(chunked(repo.car, 512), expectation(repo))
        )
        expect(error.code).toBe("did-mismatch")
    })

    it("rejects a tree that links one node twice", async () => {
        const key = makeKey()
        const encoder = new TextEncoder()
        const record = encodeDagCbor(follow("did:plc:shared"))
        const recordCid = cidOf(record)
        const entry = (name: string, right: Uint8Array | null) => ({
            p: 0,
            k: encoder.encode(`${FOLLOW}/${name}`),
            v: new Link(recordCid),
            t: right ? new Link(right) : null,
        })
        const childData = encodeDagCbor({ l: null, e: [entry("a", null)] })
        const childCid = cidOf(childData)
        const parentData = encodeDagCbor({
            l: new Link(childCid),
            e: [entry("b", childCid)],
        })
        const parentCid = cidOf(parentData)
        const unsigned = {
            did: DID,
            version: 3,
            data: new Link(parentCid),
            rev: "3kaaaaaaaaaaa",
            prev: null,
        }
        const commitData = encodeDagCbor({
            ...unsigned,
            sig: sign(key, encodeDagCbor(unsigned)),
        })
        const commitCid = cidOf(commitData)
        const car = encodeCar(commitCid, [
            { cid: commitCid, data: commitData },
            { cid: parentCid, data: parentData },
            { cid: childCid, data: childData },
            { cid: recordCid, data: record },
        ])
        const error = await rejection(
            verifyRepoCollection(chunked(car, 512), {
                did: DID,
                signingKey: key.multikey,
                collection: FOLLOW,
                maxBytes: 10_000_000,
                maxNodes: 10_000,
            })
        )
        expect(error.code).toBe("mst-malformed")
    })

    it("rejects a node whose keys are out of order", async () => {
        const key = makeKey()
        const encoder = new TextEncoder()
        const record = encodeDagCbor(follow("did:plc:shared"))
        const recordCid = cidOf(record)
        const entry = (name: string, right: Uint8Array | null) => ({
            p: 0,
            k: encoder.encode(`${FOLLOW}/${name}`),
            v: new Link(recordCid),
            t: right ? new Link(right) : null,
        })
        const parentData = encodeDagCbor({
            l: null,
            e: [entry("b", null), entry("a", null)],
        })
        const parentCid = cidOf(parentData)
        const unsigned = {
            did: DID,
            version: 3,
            data: new Link(parentCid),
            rev: "3kaaaaaaaaaaa",
            prev: null,
        }
        const commitData = encodeDagCbor({
            ...unsigned,
            sig: sign(key, encodeDagCbor(unsigned)),
        })
        const commitCid = cidOf(commitData)
        const car = encodeCar(commitCid, [
            { cid: commitCid, data: commitData },
            { cid: parentCid, data: parentData },
            { cid: recordCid, data: record },
        ])
        const error = await rejection(
            verifyRepoCollection(chunked(car, 512), {
                did: DID,
                signingKey: key.multikey,
                collection: FOLLOW,
                maxBytes: 10_000_000,
                maxNodes: 10_000,
            })
        )
        expect(error.code).toBe("mst-malformed")
    })

    it("missing follow block is a distinct error", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(5, 5) })
        const victimCid = repo.recordCids[`${FOLLOW}/f0003`]!
        const omitted = encodeCar(
            repo.root,
            repo.blocks.filter((b) => cidString(b.cid) !== victimCid)
        )
        const error = await rejection(
            verifyRepoCollection(chunked(omitted, 512), expectation(repo))
        )
        expect(error.code).toBe("block-missing")

        // A block under a follow key whose $type says otherwise is dropped, so
        // the key it sits under is likewise missing.
        const mistyped = buildRepoCar({
            did: DID,
            records: {
                ...mixedRecords(3, 0),
                [`${FOLLOW}/f9999`]: { $type: POST, text: "not a follow" },
            },
        })
        const mistypedError = await rejection(
            verifyRepoCollection(
                chunked(mistyped.car, 512),
                expectation(mistyped)
            )
        )
        expect(mistypedError.code).toBe("block-missing")
    })

    it("record with absent $type is kept and walked", async () => {
        const repo = buildRepoCar({
            did: DID,
            records: {
                [`${FOLLOW}/typed`]: follow("did:plc:typed"),
                [`${FOLLOW}/untyped`]: { subject: "did:plc:untyped" },
                [`${FOLLOW}/oddtype`]: { $type: 7, subject: "did:plc:odd" },
            },
        })
        const result = await verifyRepoCollection(
            chunked(repo.car, 64),
            expectation(repo)
        )
        expect(result.records.map((r) => r.rkey)).toEqual([
            "oddtype",
            "typed",
            "untyped",
        ])
        expect(
            result.records.find((r) => r.rkey === "untyped")!.record
        ).toEqual({ subject: "did:plc:untyped" })
    })

    it("empty collection returns no records at the signed rev", async () => {
        const repo = buildRepoCar({
            did: DID,
            rev: "3kemptyaaaaaa",
            records: mixedRecords(0, 30),
        })
        const result = await verifyRepoCollection(
            chunked(repo.car, 512),
            expectation(repo)
        )
        expect(result).toEqual({ rev: "3kemptyaaaaaa", records: [] })
    })

    it("blocks in any order", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(60, 40) })
        const forward = await verifyRepoCollection(
            chunked(repo.car, 512),
            expectation(repo)
        )
        const reversed = encodeCar(repo.root, [...repo.blocks].reverse())
        const result = await verifyRepoCollection(
            chunked(reversed, 301),
            expectation(repo)
        )
        expect(result.records).toHaveLength(60)
        expect(result).toEqual(forward)
        await expect(
            verifyRepoCollection(chunked(reversed, 1), expectation(repo))
        ).resolves.toEqual(forward)
    })

    it("refuses over the byte cap", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(40, 40) })
        const error = await rejection(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, { maxBytes: repo.car.length - 1 })
            )
        )
        expect(error.code).toBe("byte-cap-exceeded")
        await expect(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, { maxBytes: repo.car.length })
            )
        ).resolves.toBeDefined()
    })

    it("refuses over the node cap", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(150, 150) })
        const nodes = repo.blocks.length - 1 - 300
        expect(nodes).toBeGreaterThan(1)
        const error = await rejection(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, { maxNodes: nodes - 1 })
            )
        )
        expect(error.code).toBe("node-cap-exceeded")
        await expect(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, { maxNodes: nodes })
            )
        ).resolves.toBeDefined()
    })

    it("refuses past maxRecords while reading, before the walk", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(20, 5) })
        let walked = false
        let pulled = 0
        const total = Math.ceil(repo.car.length / 512)
        async function* counted(): AsyncGenerator<Uint8Array> {
            for await (const chunk of chunked(repo.car, 512)) {
                pulled++
                yield chunk
            }
        }
        const error = await rejection(
            verifyRepoCollection(
                counted(),
                expectation(repo, {
                    maxRecords: 19,
                    onRetained: () => {
                        walked = true
                    },
                })
            )
        )
        expect(error.code).toBe("record-cap-exceeded")
        expect(walked).toBe(false)
        expect(pulled).toBeLessThan(total)

        await expect(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, { maxRecords: 20 })
            )
        ).resolves.toMatchObject({ records: expect.any(Array) })
    })

    it("onRetained reports exactly the sum of the kept block sizes, commit included", async () => {
        const repo = buildRepoCar({ did: DID, records: mixedRecords(30, 40) })
        const records = new Set(Object.values(repo.recordCids))
        const followCids = new Set(
            Object.entries(repo.recordCids)
                .filter(([key]) => key.startsWith(`${FOLLOW}/`))
                .map(([, cid]) => cid)
        )
        let expectedBytes = 0
        let expectedNodes = 0
        for (const block of repo.blocks) {
            const cid = cidString(block.cid)
            if (cidString(repo.commitBlock.cid) === cid) {
                expectedBytes += block.data.length
            } else if (followCids.has(cid)) {
                expectedBytes += block.data.length
            } else if (!records.has(cid)) {
                expectedBytes += block.data.length
                expectedNodes++
            }
        }
        const reports: unknown[] = []
        await verifyRepoCollection(
            chunked(repo.car, 512),
            expectation(repo, { onRetained: (r) => reports.push(r) })
        )
        expect(reports).toEqual([
            { bytes: expectedBytes, nodes: expectedNodes, records: 30 },
        ])
        expect(expectedBytes).toBeLessThan(repo.car.length)

        const wrongKey: unknown[] = []
        await rejection(
            verifyRepoCollection(
                chunked(repo.car, 512),
                expectation(repo, {
                    signingKey: makeKey().multikey,
                    onRetained: (r) => wrongKey.push(r),
                })
            )
        )
        expect(wrongKey).toHaveLength(1)
    })
})
