/**
 * Settle, refresh, the rotation push and registration retirement decide from
 * the index, never from a snapshot-store read.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { IngestDeps } from "../src/ingest"
import type { SnapshotWriter } from "../src/storage"

describe("the writer never reads the snapshot store", () => {
    it.todo("IngestDeps.snapshot is a SnapshotWriter, with no getRecord")
    it("SnapshotWriter has no getRecord", () => {
        expectTypeOf<SnapshotWriter>().not.toHaveProperty("getRecord")
        expectTypeOf<IngestDeps>().toHaveProperty("snapshot")
    })
    it.todo("a settle detects a signing-key rotation from the indexed verifiedWith")
    it.todo("a settle reuses first-observed evidence times from the index when the snapshot store is stale")
    it.todo("a settle detects a messaging-key transition from the indexed fingerprint and keeps the old key as an unknown sentinel")
    it.todo("a quiet refresh compares the fetched record CID to the indexed cid")
    it.todo("the rotation push records the seen key in the index and writes no snapshot")
    it.todo("the rotation push is sent once per newly seen key even when the snapshot store is stale")
    it.todo("a repeated gone answer is quiet when the index holds the DID as gone")
    it.todo("registration retirement reads the anchor key from the index")
    it.todo("interest transitions reach the snapshot store only through deletes")
    it.todo("a settle re-retains evidence anchors without a previous snapshot and keeps the first-observed times")
})
