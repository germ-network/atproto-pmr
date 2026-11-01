/** Which DID's listing repairs a follow-stream frame whose handling threw. */
import { describe, expect, it } from "vitest"
import { decodeEvent, type CommitEvent } from "../src/jetstream"
import {
    BLOCK_COLLECTION_NSID,
    FOLLOW_COLLECTION_NSID,
    followEventListingDid,
    routeFollowEvent,
    type FollowRouteDeps,
    type NewEdgeOp,
} from "../src/follow-stream"
import type { OwedRecord } from "../src/storage"

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

describe("routeFollowEvent — registered owners' block proofs", () => {
    function harness(world: { interest?: string[]; owners?: string[]; registered?: string[] }) {
        const calls: unknown[] = []
        const index = {
            skipFollowEvent: async () => void calls.push("skip"),
            logEdgeOp: async (op: NewEdgeOp, _cursor: string, owed?: OwedRecord) =>
                void calls.push({ edge: op.kind, owed }),
            oweSecondary: async (owed: OwedRecord) => {
                calls.push({ owe: owed })
                return { outcome: "accepted" as const }
            },
            isGraphOwner: async (did: string) => (world.owners ?? []).includes(did),
            inInterest: async (did: string) =>
                (world.interest ?? []).includes(did) || (world.registered ?? []).includes(did),
            isRegistered: async (did: string) => (world.registered ?? []).includes(did),
        } as unknown as FollowRouteDeps["index"]
        return {
            calls,
            route: (event: CommitEvent) => routeFollowEvent({ index, secondaries: [] }, event, "1"),
        }
    }
    const event = (overrides: Partial<CommitEvent>): CommitEvent => ({
        kind: "commit",
        did: "did:plc:a",
        collection: BLOCK_COLLECTION_NSID,
        rkey: "3kb",
        operation: "create",
        rev: "3r1",
        cid: null,
        seq: null,
        timeMs: null,
        subject: "did:plc:b",
        ...overrides,
    })
    const OWED = { did: "did:plc:a", collection: BLOCK_COLLECTION_NSID, rkey: "3kb", rev: "3r1" }

    it("a registered owner's block create owes its proof fetch in the same step as the edge op", async () => {
        const h = harness({ registered: ["did:plc:a", "did:plc:b"], owners: ["did:plc:a"] })
        expect(await h.route(event({}))).toBe("edge-op")
        expect(h.calls).toEqual([{ edge: "create", owed: OWED }])
    })

    it("a registered owner's block delete owes its proof fetch in the same step as the edge op", async () => {
        const h = harness({ registered: ["did:plc:a"] })
        expect(await h.route(event({ operation: "delete", subject: null }))).toBe("edge-op")
        expect(h.calls).toEqual([{ edge: "delete", owed: OWED }])
    })

    it("a registered owner's block create not kept as an edge still owes its proof", async () => {
        const h = harness({ registered: ["did:plc:a"] })
        expect(await h.route(event({}))).toBe("owed")
        expect(h.calls).toEqual([{ owe: OWED }])
    })

    it("a block op by a DID that is not registered owes no proof", async () => {
        const h = harness({ interest: ["did:plc:a"], owners: ["did:plc:a"] })
        expect(await h.route(event({}))).toBe("edge-op")
        expect(await h.route(event({ operation: "delete", subject: null }))).toBe("edge-op")
        expect(await harness({ interest: ["did:plc:a"] }).route(event({}))).toBe("dropped")
        expect(h.calls).toEqual([
            { edge: "create", owed: undefined },
            { edge: "delete", owed: undefined },
        ])
    })

    it("a follow op owes no proof", async () => {
        const h = harness({ registered: ["did:plc:a", "did:plc:b"], owners: ["did:plc:a"] })
        expect(await h.route(event({ collection: FOLLOW_COLLECTION_NSID }))).toBe("edge-op")
        expect(h.calls).toEqual([{ edge: "create", owed: undefined }])
    })
})
