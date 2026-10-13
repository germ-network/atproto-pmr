/**
 * `verifyRecordProof`: a single-record CAR proves a record (and yields its
 * CID) only under the DID document's signing key, whatever host served it.
 */
import { describe, expect, it } from "vitest"
import { RepoProofError, readRecordFromCar, verifyRecordProof } from "../src/repo-proof"
import {
    REAL_DID,
    REAL_RECORD_CID,
    REAL_REV,
    REAL_SIGNING_KEY,
    realCar,
} from "./fixtures/real-monitor-car"
import {
    buildRepoCar,
    cidOf,
    cidString,
    encodeCar,
    highS,
    layerOf,
    makeKey,
    type Block,
} from "./fixtures/repo-car"

const DID = "did:plc:sender000000000000000000"
const PATH = "com.germnetwork.declaration/self"
const RECORD = { $type: "com.germnetwork.declaration", version: "1.1.0", currentKey: Uint8Array.of(2, 1, 2, 3) }
// Enough siblings for the MST to have several nodes and layers.
const SIBLINGS = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
        `app.bsky.feed.post/3k${String(i).padStart(4, "0")}`,
        { $type: "app.bsky.feed.post", text: `post ${i}` },
    ])
)

function expectCode(fn: () => unknown, code: string) {
    try {
        fn()
    } catch (error) {
        expect(error).toBeInstanceOf(RepoProofError)
        expect((error as RepoProofError).code).toBe(code)
        return
    }
    throw new Error(`expected RepoProofError ${code}`)
}

function verify(car: Uint8Array, signingKey: string, did = DID) {
    return verifyRecordProof(car, {
        did,
        signingKey,
        collection: "com.germnetwork.declaration",
        rkey: "self",
    })
}

describe("verifyRecordProof", () => {
    it("returns the record, its CIDv1 base32 string and rev for a valid secp256k1-signed proof", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const out = verify(repo.car, repo.key.multikey)
        expect(out.cid).toBe(repo.recordCids[PATH])
        expect(out.cid.startsWith("bafyrei")).toBe(true)
        expect(out.rev).toBe("3kaaaaaaaaaaa")
        expect((out.record as { version: string }).version).toBe("1.1.0")
        expect((out.record as { currentKey: Uint8Array }).currentKey).toEqual(
            Uint8Array.of(2, 1, 2, 3)
        )
    })

    it("accepts a P-256-signed proof", () => {
        const key = makeKey("p256")
        const repo = buildRepoCar({ did: DID, key, records: { [PATH]: RECORD, ...SIBLINGS } })
        expect(verify(repo.car, key.multikey).cid).toBe(repo.recordCids[PATH])
    })

    it("the returned cid is sha2-256 of the record block and is the v the signed MST path points at", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const recordBlock = repo.blocks.find(
            (b) => cidString(b.cid) === repo.recordCids[PATH]
        )!
        expect(verify(repo.car, repo.key.multikey).cid).toBe(cidString(cidOf(recordBlock.data)))
    })

    it("rejects a CAR that lists a different CID for the record block (block-cid-mismatch)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const wrong = cidOf(Uint8Array.of(9, 9, 9))
        const blocks = repo.blocks.map((b) =>
            cidString(b.cid) === repo.recordCids[PATH] ? { cid: wrong, data: b.data } : b
        )
        expectCode(() => verify(encodeCar(repo.root, blocks), repo.key.multikey), "block-cid-mismatch")
    })

    it("rejects a commit with version other than 3 (commit-malformed)", () => {
        const repo = buildRepoCar({ did: DID, version: 2, records: { [PATH]: RECORD } })
        expectCode(() => verify(repo.car, repo.key.multikey), "commit-malformed")
    })

    it("accepts blocks in any order, taking the commit from roots[0]", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const reversed = [...repo.blocks].reverse()
        expect(verify(encodeCar(repo.root, reversed), repo.key.multikey).cid).toBe(
            repo.recordCids[PATH]
        )
    })

    it("verifies a captured real-world monitor CAR and reproduces its known record CID", () => {
        const out = verifyRecordProof(realCar(), {
            did: REAL_DID,
            signingKey: REAL_SIGNING_KEY,
            collection: "com.germnetwork.declaration",
            rkey: "self",
        })
        expect(out.cid).toBe(REAL_RECORD_CID)
        expect(out.rev).toBe(REAL_REV)
        expect((out.record as { $type: string }).$type).toBe("com.germnetwork.declaration")
    })

    it("rejects a commit signed by a different key (signature-invalid)", () => {
        const repo = buildRepoCar({
            did: DID,
            signWith: makeKey(),
            records: { [PATH]: RECORD },
        })
        expectCode(() => verify(repo.car, repo.key.multikey), "signature-invalid")
    })

    it("rejects a high-S signature (signature-invalid)", () => {
        const repo = buildRepoCar({
            did: DID,
            mutateSig: (sig, key) => highS(key, sig),
            records: { [PATH]: RECORD },
        })
        expectCode(() => verify(repo.car, repo.key.multikey), "signature-invalid")
        const p256 = makeKey("p256")
        const p = buildRepoCar({
            did: DID,
            key: p256,
            mutateSig: (sig, key) => highS(key, sig),
            records: { [PATH]: RECORD },
        })
        expectCode(() => verify(p.car, p256.multikey), "signature-invalid")
    })

    it("rejects a commit whose did differs from the expected DID (did-mismatch)", () => {
        const repo = buildRepoCar({
            did: DID,
            commitDid: "did:plc:other00000000000000000000",
            records: { [PATH]: RECORD },
        })
        expectCode(() => verify(repo.car, repo.key.multikey), "did-mismatch")
    })

    it("rejects a block whose bytes do not hash to its CID (block-cid-mismatch)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const blocks = repo.blocks.map((b) =>
            cidString(b.cid) === repo.recordCids[PATH]
                ? { cid: b.cid, data: Uint8Array.of(...b.data, 0) }
                : b
        )
        expectCode(() => verify(encodeCar(repo.root, blocks), repo.key.multikey), "block-cid-mismatch")
    })

    it("rejects an unsupported multikey (unsupported-key)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD } })
        // z6Mk… is an Ed25519 multikey.
        expectCode(
            () => verify(repo.car, "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"),
            "unsupported-key"
        )
        expectCode(() => verify(repo.car, "not-a-multikey"), "unsupported-key")
    })

    it("rejects a truncated or non-CARv1 input (car-malformed)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        expectCode(() => verify(repo.car.subarray(0, repo.car.length - 5), repo.key.multikey), "car-malformed")
        expectCode(() => verify(repo.car.subarray(0, 3), repo.key.multikey), "car-malformed")
        expectCode(() => verify(new Uint8Array(0), repo.key.multikey), "car-malformed")
        expectCode(() => verify(Uint8Array.of(1, 0xa0), repo.key.multikey), "car-malformed")
    })

    it("rejects an MST path that is missing a node (mst-malformed)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        // Drop every block except the commit and the records: the root MST node is gone.
        const recordCids = new Set(Object.values(repo.recordCids))
        const blocks: Block[] = repo.blocks.filter(
            (b) => b === repo.commitBlock || recordCids.has(cidString(b.cid))
        )
        expectCode(() => verify(encodeCar(repo.root, blocks), repo.key.multikey), "mst-malformed")
    })

    it("reports record-absent when a valid proof shows no record at the path", () => {
        const repo = buildRepoCar({ did: DID, records: SIBLINGS })
        expectCode(() => verify(repo.car, repo.key.multikey), "record-absent")
    })

    it("returns the record for the requested rkey, not a sibling in the same node", () => {
        // "sel", "self", "selfie" share a prefix, so `self` is stored with p > 0
        // as long as all three land in one node.
        const paths = ["sel", "self", "selfie"].map(
            (r) => `com.germnetwork.declaration/${r}`
        )
        expect(new Set(paths.map(layerOf)).size).toBe(1)
        const repo = buildRepoCar({
            did: DID,
            records: {
                [paths[0]!]: { $type: "x", n: 1 },
                [paths[1]!]: RECORD,
                [paths[2]!]: { $type: "x", n: 2 },
            },
        })
        expect(verify(repo.car, repo.key.multikey).cid).toBe(repo.recordCids[PATH])
    })

    it("takes the commit from roots[0] even when other roots or a decoy commit are present", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD } })
        const decoy = buildRepoCar({
            did: DID,
            key: repo.key,
            rev: "3kzzzzzzzzzzz",
            records: { [PATH]: { ...RECORD, version: "decoy" } },
        })
        const blocks = [...decoy.blocks, ...repo.blocks]
        const out = verify(encodeCar([repo.root, decoy.root], blocks), repo.key.multikey)
        expect(out.cid).toBe(repo.recordCids[PATH])
        expect(out.rev).toBe("3kaaaaaaaaaaa")
        const flipped = verify(encodeCar([decoy.root, repo.root], blocks), repo.key.multikey)
        expect(flipped.cid).toBe(decoy.recordCids[PATH])
    })

    it("tolerates a duplicated block", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD } })
        const car = encodeCar(repo.root, [...repo.blocks, ...repo.blocks])
        expect(verify(car, repo.key.multikey).cid).toBe(repo.recordCids[PATH])
    })

    it("rejects a CAR whose roots[0] is not a commit (commit-malformed)", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const notCommit = repo.blocks.find((b) => b !== repo.commitBlock)!
        expectCode(
            () => verify(encodeCar(notCommit.cid, repo.blocks), repo.key.multikey),
            "commit-malformed"
        )
    })

})

describe("readRecordFromCar", () => {
    it("returns the same cid, record and rev as verifyRecordProof for a valid proof, without a signing key", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD, ...SIBLINGS } })
        const verified = verify(repo.car, repo.key.multikey)
        const read = readRecordFromCar(repo.car, "com.germnetwork.declaration", "self")!
        expect(read.cid).toBe(verified.cid)
        expect(read.rev).toBe(verified.rev)
        expect(read.record).toEqual(verified.record)
        expect(read.did).toBe(DID)
        // Unsigned-by-anyone CAR: still readable (signature is not checked).
        const forged = buildRepoCar({ did: DID, signWith: makeKey(), records: { [PATH]: RECORD } })
        expect(readRecordFromCar(forged.car, "com.germnetwork.declaration", "self")?.cid).toBe(
            forged.recordCids[PATH]
        )
        expect(readRecordFromCar(realCar(), "com.germnetwork.declaration", "self")?.cid).toBe(
            REAL_RECORD_CID
        )
    })

    it("still rejects a block whose bytes do not hash to its CID", () => {
        const repo = buildRepoCar({ did: DID, records: { [PATH]: RECORD } })
        const blocks = repo.blocks.map((b) =>
            cidString(b.cid) === repo.recordCids[PATH]
                ? { cid: b.cid, data: Uint8Array.of(...b.data, 0) }
                : b
        )
        expectCode(
            () => readRecordFromCar(encodeCar(repo.root, blocks), "com.germnetwork.declaration", "self"),
            "block-cid-mismatch"
        )
    })

    it("returns null when the commit's tree holds no record at the path", () => {
        const repo = buildRepoCar({ did: DID, records: SIBLINGS })
        expect(readRecordFromCar(repo.car, "com.germnetwork.declaration", "self")).toBeNull()
    })
})
