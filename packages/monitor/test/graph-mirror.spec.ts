import { describe, expect, it } from "vitest"
import { mirrorGraph, type GraphMirrorIndex } from "../src/graph-mirror"
import type { ListingQueueReason } from "../src/follow-backfill"
import type { FollowEdgeWriter, GraphMirrorRow, GraphMirrorTransition } from "../src/storage"

const row = (did: string, flags: Partial<GraphMirrorRow> = {}): GraphMirrorRow => ({
    did,
    owner: false,
    holder: false,
    member: false,
    registered: false,
    ...flags,
})

function mirror(transitions: GraphMirrorTransition[]) {
    const queued: { did: string; atMs: number; reason: ListingQueueReason }[] = []
    const index = {
        dueMirror: async () => transitions,
        markMirrored: async () => {},
    } as unknown as GraphMirrorIndex
    const edges = { mirror: async () => ({ subjects: [] }) } as unknown as FollowEdgeWriter
    const deps = {
        index,
        edges,
        listings: {
            queueListing: async (did: string, atMs: number, reason: ListingQueueReason) => {
                queued.push({ did, atMs, reason })
            },
        },
        nowMs: () => 77,
    }
    return { deps, queued }
}

describe("mirrorGraph listings", () => {
    it("queues a mutual listing for a DID that stops being served but stays in interest", async () => {
        const { deps, queued } = mirror([
            { now: row("did:a", { member: true }), mirrored: row("did:a", { owner: true, member: true }) },
            { now: row("did:b"), mirrored: row("did:b", { owner: true, member: true }) },
            { now: row("did:c", { owner: true, member: true }), mirrored: null },
            { now: row("did:d", { member: true }), mirrored: row("did:d", { member: true }) },
        ])
        expect(await mirrorGraph(deps, 10)).toBe(4)
        expect(queued).toEqual([{ did: "did:a", atMs: 77, reason: "ownership" }])
    })

    it("works without a listing queue", async () => {
        const { deps } = mirror([
            { now: row("did:a", { member: true }), mirrored: row("did:a", { owner: true, member: true }) },
        ])
        expect(await mirrorGraph({ ...deps, listings: undefined }, 10)).toBe(1)
    })
})
