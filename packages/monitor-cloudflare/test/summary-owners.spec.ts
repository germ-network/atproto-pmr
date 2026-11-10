/**
 * `summaryOwnersAffected` over the D1 graph: who a change reaches, and that
 * only graph owners are returned.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MonitorEnv } from "../src/env"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import { summaryOwnersAffected } from "../src/summary-inputs"

const db = (env as unknown as MonitorEnv & { graph: D1Database }).graph

const owners = (...dids: string[]) =>
    db.batch(dids.map((d) => db.prepare("INSERT INTO graph_owners (did) VALUES (?)").bind(d)))
const follows = (...pairs: [follower: string, subject: string][]) =>
    d1FollowEdgeWriter(db, statementBudget(1000)).putEdges(
        pairs.map(([follower, subject], i) => ({ follower, rkey: `r${i}`, subject })),
        0
    )
const affected = (dids: string[], ownersNamed: string[] = []) =>
    summaryOwnersAffected(db, { dids, owners: ownersNamed })

beforeEach(async () => {
    await db.batch(
        ["follows", "graph_owners", "graph_holders", "interest"].map((t) =>
            db.prepare(`DELETE FROM ${t}`)
        )
    )
})

describe("summaryOwnersAffected", () => {
    it("a changed DID reaches the owners who follow it", async () => {
        await owners("did:o1", "did:o2")
        await follows(["did:o1", "did:x"], ["did:o2", "did:other"])
        expect(await affected(["did:x"])).toEqual(["did:o1"])
    })

    it("a changed DID reaches the owners it follows", async () => {
        await owners("did:o1", "did:o2")
        await follows(["did:x", "did:o1"], ["did:y", "did:o2"])
        expect(await affected(["did:x"])).toEqual(["did:o1"])
    })

    it("a changed DID that is itself an owner is included", async () => {
        await owners("did:x", "did:o2")
        expect(await affected(["did:x"])).toEqual(["did:x"])
    })

    it("a DID not in graph_owners is never returned, whether reached or named in owners", async () => {
        await owners("did:o1")
        await follows(["did:o1", "did:x"], ["did:x", "did:plain"], ["did:plain2", "did:x"])
        expect(await affected(["did:x"], ["did:named"])).toEqual(["did:o1"])
    })

    it("owners are returned as named, without expanding to their followers or follows", async () => {
        await owners("did:o1", "did:f", "did:s")
        await follows(["did:f", "did:o1"], ["did:o1", "did:s"])
        expect(await affected([], ["did:o1"])).toEqual(["did:o1"])
    })

    it("more DIDs than one statement binds are all covered, deduplicated and sorted", async () => {
        const many = Array.from({ length: 130 }, (_, i) => `did:m${String(i).padStart(3, "0")}`)
        const extra = Array.from({ length: 30 }, (_, i) => `did:n${String(i).padStart(3, "0")}`)
        await owners(...many, ...extra, "did:fol")
        await follows(["did:fol", "did:m001"])
        const result = await affected(["did:m000", ...[...many].reverse()], extra)
        expect(result).toEqual([...many, ...extra, "did:fol"].sort())
    })

    it("an empty change returns no owners", async () => {
        await owners("did:o1")
        const prepared = vi.spyOn(db, "prepare")
        try {
            expect(await affected([])).toEqual([])
            expect(prepared).not.toHaveBeenCalled()
        } finally {
            prepared.mockRestore()
        }
    })
})
