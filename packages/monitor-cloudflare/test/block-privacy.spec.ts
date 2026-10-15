/** Blocks feed no public projection: no change rows, no projection change. */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { decodeEvent, flushEdgeOps, routeFollowEvent, runGraphProjector } from "@germ-network/atproto-pmr-monitor"
import { d1BlockEdgeWriter } from "../src/block-edge-store"
import { monitorCollections } from "../src/env"
import { d1FollowEdgeStore, d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import { d1GraphChangeLog } from "../src/graph-change-log"
import { kvGraphProjections } from "../src/graph-projection-store"
import type { MonitorIngest } from "../src/ingest-object"
import { all, clearGraph, db, inObj, registeredStub, step, stubNet, testEnv } from "./listing-harness"

const O = "did:plc:owner"

beforeEach(async () => {
    await clearGraph()
    await db.exec("DELETE FROM blocks")
})

const blockFrame = (operation: string, rkey: string, subject?: string) =>
    JSON.stringify({
        did: O,
        time_us: 1000,
        kind: "commit",
        commit: {
            rev: "3rev",
            operation,
            collection: "app.bsky.graph.block",
            rkey,
            cid: "bafy",
            ...(subject ? { record: { subject } } : {}),
        },
    })

/** Block activity by the socket, a listing and a mirror prune, for an owner with one served graph. */
async function blockActivity(obj: MonitorIngest, listing = true): Promise<void> {
    await obj.setRegistered(O, true, 1)
    const route = (raw: string) =>
        routeFollowEvent({ index: obj, secondaries: monitorCollections(obj.env) }, decodeEvent(raw)!, "1")
    await route(blockFrame("create", "live1", "did:plc:x"))
    await route(blockFrame("create", "live2", "did:plc:y"))
    await route(blockFrame("delete", "live1"))
    const budget = statementBudget(1000)
    await flushEdgeOps(
        {
            ops: obj,
            edges: d1FollowEdgeWriter(db, budget),
            blocks: d1BlockEdgeWriter(db, budget),
            budget,
            interest: obj,
        },
        100
    )
    if (listing) {
        stubNet(obj, { repos: { [O]: [] }, blockRepos: { [O]: [{ rkey: "listed", subject: "did:plc:z" }] } })
        await step(obj)
    }
    await db.prepare("INSERT INTO interest (did, registered) VALUES ('did:m', 0)").run()
    await db.prepare("INSERT INTO blocks (blocker, rkey, subject, gen) VALUES ('did:m', '1', 'did:plc:z', 1)").run()
    await d1FollowEdgeWriter(db, statementBudget(11)).mirror([
        {
            now: { did: "did:m", owner: false, holder: false, member: false, registered: false },
            mirrored: { did: "did:m", owner: false, holder: false, member: true, registered: false },
        },
    ])
}

describe("blocks reach no public projection", () => {
    it("block ops by socket, listing and mirror prune write no graph_changes rows", async () => {
        const s = registeredStub("bp")
        await inObj(s, blockActivity)
        const blocks = await all<{ blocker: string; rkey: string }>("SELECT blocker, rkey FROM blocks ORDER BY rkey")
        expect(blocks.map((b) => [b.blocker, b.rkey])).toEqual([[O, "listed"]])
        expect(await all("SELECT * FROM graph_changes")).toEqual([])
    })

    it("block ops by socket, listing and mirror prune leave the KV graph:<did> value unchanged", async () => {
        // O follows a holder that O also blocks, so a block reaching the
        // projection would change its bytes.
        await db.batch([
            db.prepare("INSERT INTO graph_owners (did) VALUES (?)").bind(O),
            db.prepare("INSERT INTO graph_holders (did) VALUES ('did:plc:z')"),
            db.prepare("INSERT INTO follows (follower, rkey, subject, gen) VALUES (?, 'f', 'did:plc:z', 1)").bind(O),
        ])
        const projections = kvGraphProjections(testEnv)
        const project = () =>
            runGraphProjector(
                {
                    index: {
                        projectorCursor: async () => ({ kind: "rebuild", asOfSeq: 0, phase: "project", page: null }),
                        setProjectorCursor: async () => {},
                        mirroredGraphStanding: async () => "served",
                        servedGraphsMirrored: async () => ({ dids: [O], cursor: null }),
                    },
                    changes: d1GraphChangeLog(db),
                    edges: d1FollowEdgeStore(db),
                    projections,
                    budget: statementBudget(1000),
                },
                200
            )
        await project()
        const before = await env.records.get(`graph:${O}`, "arrayBuffer")
        expect((await projections.get(O))!.following).toHaveLength(1)
        await inObj(registeredStub("bp"), (obj) => blockActivity(obj, false))
        await project()
        const after = await env.records.get(`graph:${O}`, "arrayBuffer")
        expect(new Uint8Array(after!)).toEqual(new Uint8Array(before!))
    })
})
