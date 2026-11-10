/**
 * Every committed declaration change and graph write reports its summary
 * inputs once, after the commit, and a failing report harms nothing.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    settle,
    settleDue,
    type GraphMirrorRow,
    type GraphMirrorTransition,
    type IngestDeps,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import type { FollowEdgeWriter } from "@germ-network/atproto-pmr-monitor"
import { d1FollowEdgeWriter, statementBudget } from "../src/follow-edge-store"
import type { MonitorIngest } from "../src/ingest-object"
import { summaryInputTracking, type SummaryInputsChange } from "../src/summary-inputs"
import { alarm as runAlarm, clearGraph, db, inObj, putEdge, registeredStub, stubNet } from "./listing-harness"

const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const directory = (env as unknown as MonitorEnv & { pmrDirectory: KVNamespace }).pmrDirectory
/** List `did` in the relay's directory so the registration reconcile keeps it. */
const listed = (...dids: string[]) => Promise.all(dids.map((d) => directory.put(d, "1")))

const sorted = (c: SummaryInputsChange) => ({ dids: [...c.dids].sort(), owners: [...c.owners].sort() })
const edge = (follower: string, rkey: string, subject: string) => ({ follower, rkey, subject })
const count = async (table: string, where = "1 = 1", ...binds: unknown[]) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>())!.n

beforeEach(clearGraph)

/** One alarm whose maintenance pass is due, however recently the last one ran. */
const alarm = async (s: Parameters<typeof runAlarm>[0]) => {
    await inObj(s, async (obj) => {
        obj.ctx.storage.sql.exec(
            "INSERT INTO meta (k, v) VALUES ('maintenance_at', ?1) ON CONFLICT (k) DO UPDATE SET v = ?1",
            String(Date.now() - 1)
        )
    })
    await runAlarm(s)
}

describe("summary input tracking writer", () => {
    /** A tracking writer whose reports are recorded with a D1 read taken as each arrives. */
    function tracked<T>(observe: () => Promise<T>) {
        const reports: { change: SummaryInputsChange; seen: T }[] = []
        const writer = summaryInputTracking(d1FollowEdgeWriter(db, statementBudget(1000)), async (change) => {
            reports.push({ change: sorted(change), seen: await observe() })
        })
        return { writer, reports }
    }

    it("putEdges reports both endpoints of each inserted edge as owners after the rows commit", async () => {
        const { writer, reports } = tracked(() => count("follows"))
        await writer.putEdges([edge("did:f1", "r1", "did:s1"), edge("did:f2", "r2", "did:s2")], 1)
        expect(reports).toEqual([
            { change: { dids: [], owners: ["did:f1", "did:f2", "did:s1", "did:s2"] }, seen: 2 },
        ])
    })

    it("putEdges reports a re-pointed follow's follower, old subject and new subject as owners", async () => {
        await putEdge("did:f", "r1", "did:old")
        const { writer, reports } = tracked(() => count("follows", "subject = 'did:new'"))
        await writer.putEdges([edge("did:f", "r1", "did:new")], 2)
        expect(reports).toEqual([
            { change: { dids: [], owners: ["did:f", "did:new", "did:old"] }, seen: 1 },
        ])
    })

    it("putEdges rewriting edges unchanged, as a relist does, reports nothing", async () => {
        await putEdge("did:f", "r1", "did:s")
        const { writer, reports } = tracked(async () => 0)
        const result = await writer.putEdges([edge("did:f", "r1", "did:s")], 2)
        expect(reports).toEqual([])
        expect(result.subjects).toEqual(["did:s"])
    })

    it("deleteEdges reports each deleted edge's follower and subject as owners", async () => {
        await putEdge("did:f", "r1", "did:s")
        await putEdge("did:g", "r2", "did:t")
        const { writer, reports } = tracked(() => count("follows"))
        await writer.deleteEdges([
            { follower: "did:f", rkey: "r1" },
            { follower: "did:g", rkey: "r2" },
        ])
        expect(reports).toEqual([
            { change: { dids: [], owners: ["did:f", "did:g", "did:s", "did:t"] }, seen: 0 },
        ])
    })

    it("deleteEdges of edges that do not exist reports nothing", async () => {
        const { writer, reports } = tracked(async () => 0)
        await writer.deleteEdges([{ follower: "did:f", rkey: "missing" }])
        expect(reports).toEqual([])
    })

    it("sweep reports the follower and the swept subjects as owners", async () => {
        await putEdge("did:f", "r1", "did:a", 1)
        await putEdge("did:f", "r2", "did:b", 1)
        await putEdge("did:f", "r3", "did:kept", 2)
        const { writer, reports } = tracked(() => count("follows", "follower = 'did:f'"))
        await writer.sweep("did:f", 2)
        expect(reports).toEqual([{ change: { dids: [], owners: ["did:a", "did:b", "did:f"] }, seen: 1 }])
    })

    it("mirror reports each transition's DID as a changed DID and pruned subjects as owners, after the mirror rows commit", async () => {
        await db.prepare("INSERT INTO graph_owners (did) VALUES ('did:gone')").run()
        await putEdge("did:gone", "r1", "did:s")
        const transition = (did: string, flags: Partial<GraphMirrorRow>): GraphMirrorTransition => ({
            now: { did, owner: false, holder: false, member: false, registered: false, ...flags },
            mirrored: null,
        })
        const { writer, reports } = tracked(() => count("graph_owners", "did = 'did:new'"))
        await writer.mirror([transition("did:new", { owner: true }), transition("did:gone", {})])
        expect(reports).toEqual([
            { change: { dids: ["did:gone", "did:new"], owners: ["did:s"] }, seen: 1 },
        ])
    })

    it("a write that changed nothing reports nothing", async () => {
        await putEdge("did:f", "r1", "did:kept", 2)
        const { writer, reports } = tracked(async () => 0)
        await writer.putEdges([], 1)
        await writer.deleteEdges([])
        await writer.sweep("did:f", 2)
        await writer.pruneFollower("did:nobody")
        await writer.mirror([])
        expect(reports).toEqual([])
    })

    it("a writer that does not track changed endpoints is reported by its named edges, once each", async () => {
        const reports: SummaryInputsChange[] = []
        const inner = {
            putEdges: async () => ({ subjects: ["did:s"] }),
            deleteEdges: async () => ({ subjects: ["did:s", "did:t"] }),
        } as unknown as FollowEdgeWriter
        const writer = summaryInputTracking(inner, async (c) => void reports.push(sorted(c)))
        await writer.putEdges([edge("did:f", "r1", "did:s"), edge("did:f", "r2", "did:s")], 1)
        await writer.deleteEdges([{ follower: "did:f", rkey: "r1" }])
        expect(reports).toEqual([
            { dids: [], owners: ["did:f", "did:s"] },
            { dids: [], owners: ["did:f", "did:s", "did:t"] },
        ])
    })

    it("a report that throws does not fail the write or the step's bookkeeping", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        try {
            const writer = summaryInputTracking(d1FollowEdgeWriter(db, statementBudget(1000)), async () => {
                throw new Error("queue down")
            })
            const result = await writer.putEdges([edge("did:f", "r1", "did:s")], 1)
            expect(result.subjects).toEqual(["did:s"])
            expect(await count("follows")).toBe(1)
            expect(logged).toHaveBeenCalled()
        } finally {
            logged.mockRestore()
        }
    })
})

describe("MonitorIngest.onSummaryInputsChanged", () => {
    type Hookable = { onSummaryInputsChanged: MonitorIngest["onSummaryInputsChanged"] }
    const hooked = (obj: MonitorIngest, around?: () => Promise<void>) => {
        const calls: SummaryInputsChange[] = []
        ;(obj as unknown as Hookable).onSummaryInputsChanged = async (c) => {
            await around?.()
            calls.push(sorted(c))
        }
        return calls
    }
    const depsOf = (obj: MonitorIngest) => (obj as unknown as { deps(): IngestDeps }).deps()
    const verified = (rev: string) => async () => ({ kind: "verified" as const, key: KEY, rev, cid: "bafyreistub" })
    const fetched = async () => ({ car: new Uint8Array([1]), source: "https://pds.example", signingKey: KEY })
    const settleAt = (obj: MonitorIngest, rev: string) =>
        settleDue({ ...depsOf(obj), fetchRecord: fetched, verify: verified(rev) })
    const dids = (calls: SummaryInputsChange[]) => calls.flatMap((c) => c.dids)
    const owners = (calls: SummaryInputsChange[]) => calls.flatMap((c) => c.owners)

    let n = 0
    const freshDid = () => `did:plc:summary-${(n += 1)}`
    const listedDid = async () => {
        const did = freshDid()
        await listed(did)
        return did
    }

    it("a declaration change reports its DID after the new state is stored", async () => {
        const did = freshDid()
        await inObj(registeredStub("summary"), async (obj) => {
            const stored: (string | null)[] = []
            const calls = hooked(obj, async () => void stored.push(await obj.revOf(did)))
            await obj.intake({ did, rev: "3m1" }, "c1")
            await settleAt(obj, "3m1")
            expect(calls).toEqual([{ dids: [did], owners: [] }])
            expect(stored).toEqual(["3m1"])
        })
    })

    it("a declaration deletion reports its DID", async () => {
        const did = freshDid()
        await inObj(registeredStub("summary"), async (obj) => {
            const calls = hooked(obj)
            await obj.intake({ did, rev: "3m1" }, "c1")
            await settleAt(obj, "3m1")
            calls.length = 0
            await obj.intake({ did, rev: "3m2" }, "c2")
            await settleDue({
                ...depsOf(obj),
                fetchRecord: async () => {
                    throw new RecordNotFoundError("RepoNotFound", true, "RepoNotFound")
                },
            })
            expect(await obj.isDeleted(did)).toBe(true)
            expect(calls).toEqual([{ dids: [did], owners: [] }])
        })
    })

    it("a quiet re-verify that stores the same declaration reports nothing", async () => {
        const did = freshDid()
        await inObj(registeredStub("summary"), async (obj) => {
            const calls = hooked(obj)
            await obj.intake({ did, rev: "3m1" }, "c1")
            await settleAt(obj, "3m1")
            calls.length = 0
            await settle({ ...depsOf(obj), fetchRecord: fetched, verify: verified("3m1") }, did, { quiet: true })
            expect(calls).toEqual([])
        })
    })

    it("a deployment onChange override that throws or does not call super still reports", async () => {
        const did = freshDid()
        await inObj(registeredStub("summary"), async (obj) => {
            const calls = hooked(obj)
            ;(obj as unknown as { onChange: MonitorIngest["onChange"] }).onChange = async () => {
                throw new Error("override failed")
            }
            await obj.intake({ did, rev: "3m1" }, "c1")
            await settleAt(obj, "3m1")
            expect(calls).toEqual([{ dids: [did], owners: [] }])
        })
    })

    it("a throwing hook does not fail the settle that raised it", async () => {
        const did = freshDid()
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        try {
            await inObj(registeredStub("summary"), async (obj) => {
                ;(obj as unknown as Hookable).onSummaryInputsChanged = async () => {
                    throw new Error("hook down")
                }
                await obj.intake({ did, rev: "3m1" }, "c1")
                await settleAt(obj, "3m1")
                expect(await obj.revOf(did)).toBe("3m1")
                expect(await obj.duePending(Date.now() + 1e12, 10)).toEqual([])
            })
        } finally {
            logged.mockRestore()
        }
    })

    it("leaving interest reports the DID", async () => {
        const did = await listedDid()
        const s = registeredStub("summary")
        await inObj(s, (obj) => obj.setRegistered(did, true, 1))
        await alarm(s)
        const calls = await inObj(s, async (obj) => {
            await obj.setRegistered(did, false, 2)
            // Only the interest step may report: keep the graph steps out.
            ;(obj as unknown as { runGraphSteps(): Promise<void> }).runGraphSteps = async () => {}
            return hooked(obj)
        })
        await alarm(s)
        expect(dids(calls)).toContain(did)
    })

    it("the alarm's graph steps report a mirrored holder transition", async () => {
        const did = await listedDid()
        const s = registeredStub("summary")
        const calls = await inObj(s, async (obj) => {
            await obj.setRegistered(did, true, 1)
            return hooked(obj)
        })
        await alarm(s)
        expect(dids(calls)).toContain(did)
    })

    it("the alarm's listing step reports the listed follower and its subjects", async () => {
        const follower = await listedDid()
        const s = registeredStub("summary")
        const calls = await inObj(s, async (obj) => {
            const seen = hooked(obj)
            const list = [{ rkey: "a", subject: "did:plc:sub-a" }]
            stubNet(obj, { lists: { [follower]: list }, repos: { [follower]: list } })
            await obj.register(follower)
            return seen
        })
        await alarm(s)
        expect(owners(calls)).toEqual(expect.arrayContaining([follower, "did:plc:sub-a"]))
    })

    it("the alarm's edge flush reports the flushed edges' endpoints", async () => {
        const f = await listedDid()
        const s = registeredStub("summary")
        await inObj(s, (obj) => obj.setRegistered(f, true, 1))
        await alarm(s)
        const calls = await inObj(s, async (obj) => {
            const seen = hooked(obj)
            await obj.logEdgeOp(
                { collection: "follow", kind: "create", follower: f, rkey: "r1", subject: "did:plc:flushed", rev: "r", cursor: "1" },
                "1"
            )
            return seen
        })
        await alarm(s)
        expect(owners(calls)).toEqual(expect.arrayContaining([f, "did:plc:flushed"]))
    })

    it("a throwing hook does not stop the alarm's later graph steps", async () => {
        const did = await listedDid()
        const s = registeredStub("summary")
        const logged = vi.spyOn(console, "error").mockImplementation(() => {})
        try {
            await inObj(s, async (obj) => {
                ;(obj as unknown as Hookable).onSummaryInputsChanged = async () => {
                    throw new Error("hook down")
                }
                await obj.setRegistered(did, true, 1)
                await obj.logEdgeOp(
                    { collection: "follow", kind: "create", follower: did, rkey: "r1", subject: "did:plc:later", rev: "r", cursor: "1" },
                    "1"
                )
            })
            await alarm(s)
            expect(await count("follows", "follower = ?", did)).toBe(1)
            await inObj(s, async (obj) => {
                const row = obj.ctx.storage.sql
                    .exec("SELECT inflight FROM graph_mirrored WHERE did = ?", did)
                    .toArray()
                expect(row).toEqual([{ inflight: 0 }])
            })
        } finally {
            logged.mockRestore()
        }
    })
})
