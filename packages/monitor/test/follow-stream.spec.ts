/** Which DID's listing repairs a follow-stream frame whose handling threw. */
import { describe, expect, it } from "vitest"
import { decodeEvent } from "../src/jetstream"
import { BLOCK_COLLECTION_NSID, FOLLOW_COLLECTION_NSID, followEventListingDid } from "../src/follow-stream"

const decode = (frame: Record<string, unknown>) => {
    const e = decodeEvent(JSON.stringify(frame))
    if (e === null) throw new Error("undecodable test frame")
    return e
}
const commit = (collection: string, operation: string) =>
    decode({
        did: "did:plc:a",
        time_us: 1,
        kind: "commit",
        commit: { rev: "3r1", operation, collection, rkey: "r", cid: "bafy" },
    })

describe("followEventListingDid", () => {
    it("a follow or block create, update or delete names its author", () => {
        for (const collection of [FOLLOW_COLLECTION_NSID, BLOCK_COLLECTION_NSID]) {
            for (const operation of ["create", "update", "delete"]) {
                expect(followEventListingDid(commit(collection, operation))).toBe("did:plc:a")
            }
        }
    })

    it("#sync names its DID", () => {
        expect(followEventListingDid(decode({ did: "did:plc:a", time_us: 1, kind: "sync" }))).toBe("did:plc:a")
    })

    it("#account names its DID only when turning active", () => {
        const account = (active: boolean) =>
            decode({ did: "did:plc:a", time_us: 1, kind: "account", account: { active } })
        expect(followEventListingDid(account(true))).toBe("did:plc:a")
        expect(followEventListingDid(account(false))).toBeNull()
    })

    it("a secondary commit, an identity event and an inactive #account name no DID", () => {
        expect(followEventListingDid(commit("app.bsky.actor.profile", "create"))).toBeNull()
        expect(followEventListingDid(decode({ did: "did:plc:a", time_us: 1, kind: "identity" }))).toBeNull()
        expect(
            followEventListingDid(
                decode({ did: "did:plc:a", time_us: 1, kind: "account", account: { active: false } })
            )
        ).toBeNull()
    })
})
