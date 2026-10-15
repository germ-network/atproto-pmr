/**
 * The verified repo walk inside workerd, where an owner listing runs: a CAR
 * at the listing's byte cap, and one at its record cap, must verify or be
 * refused inside the isolate beside the object's sockets.
 */
import { describe, expect, it } from "vitest"
import {
    RepoCollectionError,
    verifyRepoCollection,
    type RepoCollectionExpectation,
    type RetainedBlocks,
} from "@germ-network/atproto-pmr-core"
import { buildRepoCar, cidString, type BuiltRepo } from "../../core/test/fixtures/repo-car"
import {
    clearGraph,
    follows,
    inObj,
    priv,
    registeredStub,
    setEnv,
    stagedCount,
    step,
} from "./listing-harness"

const DID = "did:plc:big"
const FOLLOW = "app.bsky.graph.follow"
const MAX_FOLLOWS = 20_000
const EIGHT_MIB = 8 * 1024 * 1024

async function* chunked(bytes: Uint8Array, size = 65_536): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

const followRecords = (count: number, posts = 0, postText = "") => {
    const records: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
        records[`${FOLLOW}/${String(i).padStart(6, "0")}`] = {
            $type: FOLLOW,
            subject: `did:plc:subject${String(i).padStart(8, "0")}`,
            createdAt: "2026-01-01T00:00:00.000Z",
        }
    }
    for (let i = 0; i < posts; i++) {
        records[`app.bsky.feed.post/${String(i).padStart(6, "0")}`] = {
            $type: "app.bsky.feed.post",
            text: `${i} ${postText}`,
        }
    }
    return records
}

const expectation = (
    repo: BuiltRepo,
    overrides: Partial<RepoCollectionExpectation> = {}
): RepoCollectionExpectation => ({
    did: DID,
    signingKey: repo.key.multikey,
    collection: FOLLOW,
    maxBytes: 64 * 1024 * 1024,
    maxNodes: 200_000,
    ...overrides,
})

/** The size of every block the read keeps: the commit, MST nodes and the collection's records. */
function keptBytes(repo: BuiltRepo, isRecordOutsideCollection: (cid: string) => boolean): number {
    let total = 0
    for (const block of repo.blocks) {
        if (!isRecordOutsideCollection(cidString(block.cid))) total += block.data.length
    }
    return total
}

let allFollows: BuiltRepo | null = null
const capSized = () => (allFollows ??= buildRepoCar({ did: DID, records: followRecords(MAX_FOLLOWS) }))

describe("verifyRepoCollection in workerd", () => {
    it("a cap-sized CAR verifies inside workerd", async () => {
        const repo = capSized()
        const verified = await verifyRepoCollection(
            chunked(repo.car),
            expectation(repo, { maxRecords: MAX_FOLLOWS })
        )
        expect(verified.records).toHaveLength(MAX_FOLLOWS)
    }, 120_000)

    it("an all-follows CAR is refused at MAX_FOLLOWS records, inside workerd", async () => {
        const repo = capSized()
        let retained = false
        const error = await verifyRepoCollection(
            chunked(repo.car),
            expectation(repo, { maxRecords: MAX_FOLLOWS - 1, onRetained: () => (retained = true) })
        ).then(
            () => null,
            (e: unknown) => e
        )
        expect(error).toBeInstanceOf(RepoCollectionError)
        expect((error as RepoCollectionError).code).toBe("record-cap-exceeded")
        expect(retained).toBe(false)
    }, 120_000)

    it("a MAX_FOLLOWS-record CAR retains the sum of its kept block sizes, under 8 MiB", async () => {
        const repo = capSized()
        const reports: RetainedBlocks[] = []
        await verifyRepoCollection(
            chunked(repo.car),
            expectation(repo, { maxRecords: MAX_FOLLOWS, onRetained: (r) => reports.push(r) })
        )
        expect(reports).toHaveLength(1)
        expect(reports[0]!.records).toBe(MAX_FOLLOWS)
        expect(reports[0]!.bytes).toBe(keptBytes(repo, () => false))
        expect(reports[0]!.bytes).toBeLessThan(EIGHT_MIB)
    }, 120_000)

    it("a byte-cap-sized mixed CAR retains only its follow blocks, nodes and commit", async () => {
        const repo = buildRepoCar({ did: DID, records: followRecords(300, 2_500, "x".repeat(3_000)) })
        const posts = new Set(
            Object.entries(repo.recordCids)
                .filter(([path]) => !path.startsWith(`${FOLLOW}/`))
                .map(([, cid]) => cid)
        )
        const reports: RetainedBlocks[] = []
        const verified = await verifyRepoCollection(
            chunked(repo.car),
            expectation(repo, { maxBytes: repo.car.length, onRetained: (r) => reports.push(r) })
        )
        expect(verified.records).toHaveLength(300)
        expect(reports[0]!.records).toBe(300)
        expect(reports[0]!.bytes).toBe(keptBytes(repo, (cid) => posts.has(cid)))
        expect(reports[0]!.bytes).toBeLessThan(repo.car.length / 20)
    }, 120_000)

    it("a repo past FOLLOW_MAX_REPO_BYTES is refused before the walk, and nothing is written", async () => {
        await clearGraph()
        const repo = buildRepoCar({ did: DID, records: followRecords(400) })
        const s = registeredStub("memory")
        let retained = false
        await inObj(s, async (obj) => {
            setEnv(obj, { FOLLOW_MAX_REPO_BYTES: String(repo.car.length - 1) })
            await obj.register(DID)
            const o = obj as unknown as Record<string, unknown>
            o.fetchRepo = async () => ({
                car: chunked(repo.car, 4_096),
                signingKey: repo.key.multikey,
                source: "https://pds.invalid",
                didDocument: { document: { id: DID }, fetchedAtMs: 0 },
            })
            const verify = (priv(obj) as unknown as {
                verifyRepo: (c: AsyncIterable<Uint8Array>, e: RepoCollectionExpectation) => Promise<unknown>
            }).verifyRepo.bind(obj)
            o.verifyRepo = (car: AsyncIterable<Uint8Array>, e: RepoCollectionExpectation) =>
                verify(car, { ...e, onRetained: () => (retained = true) })
            expect(await step(obj)).toEqual(["switched-to-paged"])
            expect(stagedCount(obj)).toBe(0)
        })
        expect(retained).toBe(false)
        expect(await follows()).toEqual([])
    }, 120_000)
})
