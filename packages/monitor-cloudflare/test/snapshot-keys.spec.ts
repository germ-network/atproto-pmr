/**
 * Where a record's snapshot lives in KV. The declaration's keys predate any
 * other collection and are already populated, so they must not move.
 */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import { describe, expect, it } from "vitest"
import { snapshotKeys } from "../src/snapshot-store"

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"

describe("snapshotKeys", () => {
    it("keeps the declaration's bare rec:<did> / chk:<did> keys", () => {
        expect(snapshotKeys(DID, DECLARATION_COLLECTION_NSID, "self")).toEqual({
            record: `rec:${DID}`,
            check: `chk:${DID}`,
        })
    })

    it("keys any other record by collection, rkey and DID", () => {
        expect(snapshotKeys(DID, "app.bsky.actor.profile", "self")).toEqual({
            record: `rec:app.bsky.actor.profile/self:${DID}`,
            check: `chk:app.bsky.actor.profile/self:${DID}`,
        })
    })

    it("keys a declaration record other than self by collection too", () => {
        expect(snapshotKeys(DID, DECLARATION_COLLECTION_NSID, "other")).toEqual({
            record: `rec:${DECLARATION_COLLECTION_NSID}/other:${DID}`,
            check: `chk:${DECLARATION_COLLECTION_NSID}/other:${DID}`,
        })
    })
})

describe("kvRecordSnapshots", () => {
    // One read surface serves the declaration and every secondary, with the
    // ingest's verdict, and a confirmation counts only at its own record's rev.
    it.todo("declaration keeps bare rec:/chk: keys")
    it.todo("secondary round-trips under its collection-scoped keys")
    it.todo("entry without verified metadata reads verifiedWith null")
    it.todo("chk: for a secondary is honoured only at that record's rev")
    it.todo("unset or empty MONITOR_COLLECTIONS watches no secondary")
})
