/** The owner's graph from raw follow edges: the mutual rule and a stable order. */
import { describe, expect, it } from "vitest"
import { ownerGraph, type FollowEdge } from "../src"

const ME = "did:plc:me"
const A = "did:plc:a"
const B = "did:plc:b"
const edge = (follower: string, subject: string, rkey: string): FollowEdge => ({
    follower,
    subject,
    rkey,
})

describe("owner graph", () => {
    it("flags an edge mutual iff the reverse edge is present", () => {
        const out = ownerGraph(
            ME,
            [edge(ME, A, "r1"), edge(ME, B, "r2")],
            [edge(A, ME, "r3")]
        )
        expect(out).toEqual({
            did: ME,
            following: [
                { did: A, mutual: true },
                { did: B, mutual: false },
            ],
            followers: [{ did: A, mutual: true }],
        })
        expect(ownerGraph(ME, [], [edge(B, ME, "r4")]).followers).toEqual([
            { did: B, mutual: false },
        ])
    })

    it("sorts edges by did, so equal inputs give equal graphs", () => {
        const following = [edge(ME, B, "r2"), edge(ME, A, "r1")]
        const followers = [edge(B, ME, "r4"), edge(A, ME, "r3")]
        const forward = ownerGraph(ME, following, followers)
        expect(forward.following.map((e) => e.did)).toEqual([A, B])
        expect(forward.followers.map((e) => e.did)).toEqual([A, B])
        expect(ownerGraph(ME, [...following].reverse(), [...followers].reverse())).toEqual(forward)
    })

    it("gives one edge per other party when a pair has two follow records", () => {
        const out = ownerGraph(
            ME,
            [edge(ME, A, "r1"), edge(ME, A, "r2")],
            [edge(A, ME, "r3"), edge(A, ME, "r4")]
        )
        expect(out.following).toEqual([{ did: A, mutual: true }])
        expect(out.followers).toEqual([{ did: A, mutual: true }])
    })
})
