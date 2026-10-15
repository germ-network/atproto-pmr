/** Block commits on the follow/profile stream, routed by the keep rule. */
import { describe, expect, it } from "vitest"
import type { CommitEvent } from "../src/jetstream"
import {
    BLOCK_COLLECTION_NSID,
    FOLLOW_COLLECTION_NSID,
    routeFollowEvent,
    type FollowRouteDeps,
    type NewEdgeOp,
} from "../src/follow-stream"

interface World {
    owners?: string[]
    interest?: string[]
    registered?: string[]
}

function harness(world: World) {
    const logged: NewEdgeOp[] = []
    let skipped = 0
    const unused = async () => {
        throw new Error("unexpected call")
    }
    const index = {
        readFollowCursor: unused,
        requeueListing: unused,
        oweSecondary: unused,
        async skipFollowEvent() {
            skipped++
        },
        async logEdgeOp(op: NewEdgeOp) {
            logged.push(op)
        },
        async isGraphOwner(did: string) {
            return (world.owners ?? []).includes(did)
        },
        async inInterest(did: string) {
            return (world.interest ?? []).includes(did) || (world.owners ?? []).includes(did)
        },
        async isRegistered(did: string) {
            return (world.registered ?? []).includes(did)
        },
    } as unknown as FollowRouteDeps["index"]
    return {
        logged,
        skipped: () => skipped,
        route: (event: CommitEvent) => routeFollowEvent({ index, secondaries: [] }, event, "1"),
    }
}

const commit = (overrides: Partial<CommitEvent>): CommitEvent => ({
    kind: "commit",
    did: "did:blocker",
    collection: BLOCK_COLLECTION_NSID,
    rkey: "3k1",
    operation: "create",
    rev: "rev1",
    cid: null,
    seq: null,
    timeMs: null,
    subject: "did:subject",
    ...overrides,
})

describe("routeFollowEvent — blocks", () => {
    it("keeps every block create by a graph owner", async () => {
        const h = harness({ owners: ["did:blocker"] })
        expect(await h.route(commit({}))).toBe("edge-op")
        expect(await h.route(commit({ operation: "update", rkey: "3k2" }))).toBe("edge-op")
        expect(h.logged).toEqual([
            {
                collection: "block",
                kind: "create",
                follower: "did:blocker",
                rkey: "3k1",
                subject: "did:subject",
                rev: "rev1",
                cursor: "1",
            },
            expect.objectContaining({ collection: "block", kind: "create", rkey: "3k2" }),
        ])
    })

    it("keeps a block create by a non-owner in interest only when its subject is registered", async () => {
        const h = harness({ interest: ["did:blocker"], registered: ["did:subject"] })
        expect(await h.route(commit({}))).toBe("edge-op")
        expect(await h.route(commit({ subject: "did:other" }))).toBe("dropped")
        expect(h.logged).toHaveLength(1)
        expect(h.skipped()).toBe(1)
    })

    it("drops a block create by a DID outside interest", async () => {
        const h = harness({ registered: ["did:subject"] })
        expect(await h.route(commit({}))).toBe("dropped")
        expect(h.logged).toEqual([])
    })

    it("keeps a block delete when the blocker is in interest, logged as a block op", async () => {
        const kept = harness({ interest: ["did:blocker"] })
        expect(await kept.route(commit({ operation: "delete", subject: null }))).toBe("edge-op")
        expect(kept.logged).toEqual([
            {
                collection: "block",
                kind: "delete",
                follower: "did:blocker",
                rkey: "3k1",
                rev: "rev1",
                cursor: "1",
            },
        ])
        const outside = harness({})
        expect(await outside.route(commit({ operation: "delete", subject: null }))).toBe("dropped")
    })

    it("drops a block create with no subject", async () => {
        const h = harness({ owners: ["did:blocker"] })
        expect(await h.route(commit({ subject: null }))).toBe("dropped")
        expect(h.logged).toEqual([])
    })

    it("logs a follow under the follow collection", async () => {
        const h = harness({ owners: ["did:blocker"] })
        await h.route(commit({ collection: FOLLOW_COLLECTION_NSID }))
        expect(h.logged[0]).toMatchObject({ collection: "follow" })
    })
})
