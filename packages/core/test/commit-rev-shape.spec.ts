/**
 * A commit's rev must be a TID, so every rev the monitor stores has a bounded
 * length.
 */
import { describe, expect, it } from "vitest"
import { RepoProofError, verifyRecordProofOutcome } from "../src"
import { buildRepoCar, makeKey } from "./fixtures/repo-car"

const DID = "did:plc:revshape"
const PATH = "com.germnetwork.declaration/self"

function proof(rev: string) {
    const key = makeKey()
    const repo = buildRepoCar({
        did: DID,
        key,
        rev,
        records: { [PATH]: { $type: "com.germnetwork.declaration", n: 1 } },
    })
    return () =>
        verifyRecordProofOutcome(repo.car, {
            did: DID,
            signingKey: key.multikey,
            collection: "com.germnetwork.declaration",
            rkey: "self",
        })
}

describe("commit rev shape", () => {
    it("a commit whose rev is not a TID is commit-malformed", () => {
        for (const rev of ["3m1", "3kaaaaaaaaaaaa", "9kaaaaaaaaaaa", "x".repeat(300), ""]) {
            const run = proof(rev)
            expect(run).toThrow(RepoProofError)
            expect(run).toThrow(expect.objectContaining({ code: "commit-malformed" }))
        }
    })

    it("a commit with a TID rev decodes as before", () => {
        expect(proof("3kaaaaaaaaaaa")()).toMatchObject({ kind: "present", rev: "3kaaaaaaaaaaa" })
    })
})
