/** The owner's graph from raw follow edges: the mutual rule and a stable order. */
import { describe, expect, it } from "vitest"
import { followRkeyAtMs, ownerGraph, type FollowEdge } from "../src"

const ME = "did:plc:me"
const A = "did:plc:a"
const B = "did:plc:b"
const edge = (follower: string, subject: string, rkey: string): FollowEdge => ({
    follower,
    subject,
    rkey,
})

function tidAtMs(ms: number, clockId = 0): string {
    const alphabet = "234567abcdefghijklmnopqrstuvwxyz"
    let value = (BigInt(ms) * 1000n << 10n) | BigInt(clockId)
    let out = ""
    for (let i = 0; i < 13; i++) {
        out = alphabet[Number(value & 31n)] + out
        value >>= 5n
    }
    return out
}

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
                { did: A, mutual: true, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null },
                { did: B, mutual: false, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null },
            ],
            followers: [{ did: A, mutual: true, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null }],
        })
        expect(ownerGraph(ME, [], [edge(B, ME, "r4")]).followers).toEqual([
            { did: B, mutual: false, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null },
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
        expect(out.following).toEqual([{ did: A, mutual: true, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null }])
        expect(out.followers).toEqual([{ did: A, mutual: true, ownerFollowsContactAtMs: null, contactFollowsOwnerAtMs: null }])
    })

    it("uses the newest valid active rkey TID and makes a direction unknown on any malformed duplicate", () => {
        const old = tidAtMs(1_700_000_000_000, 1)
        const newest = tidAtMs(1_700_000_000_007, 2)
        expect(followRkeyAtMs(old)).toBe(1_700_000_000_000)
        expect(ownerGraph(ME, [edge(ME, A, old), edge(ME, A, newest)], []).following[0]).toMatchObject({
            ownerFollowsContactAtMs: 1_700_000_000_007,
        })
        expect(ownerGraph(ME, [edge(ME, A, old), edge(ME, A, "bad")], []).following[0]).toMatchObject({
            ownerFollowsContactAtMs: null,
        })
    })
})
