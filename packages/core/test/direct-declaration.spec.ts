/**
 * `directDeclarationResolver`: a sender's declaration read straight from its
 * PDS, verified as strictly as a monitor snapshot, under a bounded time.
 *
 * Harness: reuse the signed-CAR fixtures `declaration-snapshot.spec.ts` builds
 * (a repo commit signed under a `#atproto` multikey holding a declaration
 * with `currentKey`). `fetchProofCar` is a fake returning those bytes, a
 * never-settling promise that honours `signal`, or a rejection.
 */
import { describe, it } from "vitest"

describe("direct declaration read", () => {
    it.todo("a proof CAR signed under the DID's #atproto key yields the anchor key, record CID, commit rev and the CAR")
    it.todo("a CAR whose commit signature fails under the DID's #atproto key is found: false")
    it.todo("a CAR whose commit names another DID is found: false")
    it.todo("a CAR proving the declaration absent is found: false")
    it.todo("a declaration without readable currentKey bytes is found: false")
    it.todo("no #atproto signing key for the DID is found: false without fetching the CAR")
    it.todo("a PDS slower than timeoutMs is found: false and the fetch's signal is aborted")
    it.todo("a signing-key resolution slower than timeoutMs is found: false: one deadline bounds the whole read")
    it.todo("a rejected fetch is found: false rather than a thrown error")
    it.todo("fetchRecordProofCar rejects once its signal aborts, during PDS resolution or the record fetch")
})
