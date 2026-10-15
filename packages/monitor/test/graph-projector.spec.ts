/**
 * The public graph projections follow the edge index's change log: every
 * served graph a row names is re-projected, an unserved one has its
 * projection deleted, and a projector that falls behind retention rebuilds.
 */
import { describe, expect, it, vi } from "vitest"
import {
    projectGraph,
    type FollowEdge,
    type GraphChangeReason,
    type GraphChangeRow,
    type GraphReadResponse,
} from "@germ-network/atproto-pmr-core"
import {
    PROJECT_STATEMENTS_PER_DID,
    runGraphProjector,
    type GraphProjectorDeps,
    type MirroredGraphStanding,
    type ProjectorCursor,
} from "../src/graph-projector"

const A = "did:plc:a"
const B = "did:plc:b"
const C = "did:plc:c"
const D = "did:plc:d"

function world(opts: { budget?: number } = {}) {
    const rows: GraphChangeRow[] = []
    const standing = new Map<string, MirroredGraphStanding>()
    const following = new Map<string, FollowEdge[]>()
    const followers = new Map<string, FollowEdge[]>()
    const held = new Map<string, GraphReadResponse>()
    const w = {
        cursor: null as ProjectorCursor | null,
        cursorWrites: 0,
        budget: opts.budget ?? 1_000,
        failPutFor: new Set<string>(),
        edgeReads: [] as string[],
        deletes: [] as string[],
        row(seq: number, did: string, reason: GraphChangeReason = "following") {
            rows.push({ seq, did, reason, atMs: seq })
        },
        serve(...dids: string[]) {
            for (const d of dids) standing.set(d, "served")
        },
        standing,
        held,
        following,
        followers,
    }
    const deps: GraphProjectorDeps = {
        index: {
            projectorCursor: async () => w.cursor,
            setProjectorCursor: async (c) => {
                w.cursor = c
                w.cursorWrites += 1
            },
            mirroredGraphStanding: async (did) => standing.get(did) ?? "not-served",
            servedGraphsMirrored: async (cursor, limit) => {
                const all = [...standing]
                    .filter(([, s]) => s !== "not-served")
                    .map(([d]) => d)
                    .sort()
                const start = cursor === null ? 0 : all.findIndex((d) => d > cursor)
                if (start < 0) return { dids: [], cursor: null }
                const dids = all.slice(start, start + limit)
                return { dids, cursor: start + limit >= all.length ? null : dids.at(-1)! }
            },
        },
        changes: {
            readSince: async (seq, limit) => ({
                rows: rows.filter((r) => r.seq > seq).slice(0, limit),
                maxSeq: rows.at(-1)?.seq ?? 0,
            }),
        },
        edges: {
            ownEdges: async () => {
                throw new Error("unused")
            },
            following: async (did) => {
                w.edgeReads.push(`following ${did}`)
                return following.get(did) ?? []
            },
            followers: async (did) => {
                w.edgeReads.push(`followers ${did}`)
                return followers.get(did) ?? []
            },
        },
        projections: {
            get: async (did) => held.get(did) ?? null,
            put: async (p) => {
                if (w.failPutFor.has(p.did)) throw new Error("write failed")
                held.set(p.did, p)
            },
            delete: async (did) => {
                w.deletes.push(did)
                held.delete(did)
            },
            listDids: async (cursor, limit) => {
                const all = [...held.keys()].sort()
                const start = cursor === null ? 0 : all.findIndex((d) => d > cursor)
                if (start < 0) return { dids: [], cursor: null }
                const dids = all.slice(start, start + limit)
                return { dids, cursor: start + limit >= all.length ? null : dids.at(-1)! }
            },
        },
        budget: {
            get remaining() {
                return w.budget
            },
            take: (n) => {
                if (w.budget < n) return false
                w.budget -= n
                return true
            },
        },
    }
    return { w, deps }
}

const edge = (follower: string, subject: string, rkey = "r"): FollowEdge => ({
    follower,
    subject,
    rkey,
})

describe("runGraphProjector", () => {
    describe("tail", () => {
        it("a row for a served graph writes its projection from the edge reads", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 0 }
            w.serve(A, B)
            w.following.set(A, [edge(A, B, "f1")])
            w.followers.set(A, [edge(B, A, "f2")])
            w.row(1, A)
            expect(await runGraphProjector(deps, 10)).toBe(1)
            expect(w.held.get(A)).toEqual(
                projectGraph(A, [edge(A, B, "f1")], [edge(B, A, "f2")])
            )
            expect(w.held.has(B)).toBe(false)
        })

        it("a DID named by several rows in one pass is projected once", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 0 }
            w.serve(A)
            w.row(1, A)
            w.row(2, A, "followers")
            w.row(3, A, "holder-add")
            expect(await runGraphProjector(deps, 10)).toBe(1)
            expect(w.edgeReads).toEqual([`following ${A}`, `followers ${A}`])
            expect(w.cursor).toEqual({ kind: "tail", seq: 3 })
        })

        it("a row for a graph not served in the mirrored standing deletes its projection", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 0 }
            w.held.set(A, projectGraph(A, [], []))
            w.row(1, A)
            expect(await runGraphProjector(deps, 10)).toBe(1)
            expect(w.held.has(A)).toBe(false)
            expect(w.edgeReads).toEqual([])
        })

        it("a DID whose mirrored standing is in flight stops the pass, cursor before it, and is not deleted", async () => {
            const { w, deps } = world()
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            try {
                w.cursor = { kind: "tail", seq: 0 }
                w.serve(A, C)
                w.standing.set(B, "in-flight")
                w.held.set(B, projectGraph(B, [], []))
                w.row(1, A)
                w.row(2, B)
                w.row(3, C)
                expect(await runGraphProjector(deps, 10)).toBe(1)
                expect(w.cursor).toEqual({ kind: "tail", seq: 1 })
                expect(w.held.has(B)).toBe(true)
                expect(w.held.has(C)).toBe(false)
                expect(warn).toHaveBeenCalledTimes(1)
            } finally {
                warn.mockRestore()
            }
        })

        it("a served-remove row deletes the projection", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 4 }
            w.held.set(A, projectGraph(A, [], []))
            w.row(5, A, "served-remove")
            await runGraphProjector(deps, 10)
            expect(w.deletes).toEqual([A])
            expect(w.held.has(A)).toBe(false)
        })

        it("the cursor advances to the last row whose write completed", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 0 }
            w.serve(A, B)
            w.row(1, A)
            w.row(2, B)
            w.row(3, A)
            await runGraphProjector(deps, 10)
            expect(w.cursor).toEqual({ kind: "tail", seq: 3 })
            // Later rows are picked up from there.
            w.row(4, B)
            await runGraphProjector(deps, 10)
            expect(w.cursor).toEqual({ kind: "tail", seq: 4 })
        })

        it("a failed write leaves the cursor before that row, so it is retried", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 0 }
            w.serve(A, B, C)
            w.row(1, A)
            w.row(2, B)
            w.row(3, A)
            w.row(4, C)
            w.failPutFor.add(B)
            await expect(runGraphProjector(deps, 10)).rejects.toThrow("write failed")
            // A's later row (3) is past B's, so the cursor stops before B's row.
            expect(w.cursor).toEqual({ kind: "tail", seq: 1 })
            w.failPutFor.clear()
            await runGraphProjector(deps, 10)
            expect(w.held.has(B)).toBe(true)
            expect(w.cursor).toEqual({ kind: "tail", seq: 4 })
        })

        it("stops before a DID the statement budget cannot pay for, cursor before it", async () => {
            const { w, deps } = world({ budget: PROJECT_STATEMENTS_PER_DID })
            w.cursor = { kind: "tail", seq: 0 }
            w.serve(A, B)
            w.row(1, A)
            w.row(2, B)
            expect(await runGraphProjector(deps, 10)).toBe(1)
            expect(w.held.has(A)).toBe(true)
            expect(w.held.has(B)).toBe(false)
            expect(w.cursor).toEqual({ kind: "tail", seq: 1 })
            expect(w.budget).toBe(0)
        })

        it("no rows past the cursor changes nothing", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 2 }
            w.serve(A)
            w.row(1, A)
            w.row(2, A)
            expect(await runGraphProjector(deps, 10)).toBe(0)
            expect(w.cursorWrites).toBe(0)
            expect(w.held.size).toBe(0)
            expect(w.budget).toBe(1_000)
        })
    })

    describe("rebuild", () => {
        it("the first run, with no cursor, rebuilds as of the log's high-water mark", async () => {
            const { w, deps } = world()
            w.serve(A)
            w.row(1, A)
            w.row(2, B)
            w.row(3, A)
            // One page is small enough to leave the rebuild mid-way.
            await runGraphProjector(deps, 1)
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 3, phase: "sweep", page: null })
            expect(w.held.has(A)).toBe(true)
        })

        it("a first row past cursor + 1 starts a rebuild", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 2 }
            w.serve(A)
            w.row(7, A)
            w.row(8, B)
            await runGraphProjector(deps, 1)
            expect(w.cursor).toMatchObject({ kind: "rebuild", asOfSeq: 8 })
            expect(w.held.has(A)).toBe(true)
        })

        it("project phase re-projects every mirrored served graph, paged across runs", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "project", page: null }
            w.serve(A, B, C)
            w.standing.set(D, "not-served")
            await runGraphProjector(deps, 2)
            expect([...w.held.keys()].sort()).toEqual([A, B])
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "project", page: B })
            await runGraphProjector(deps, 2)
            expect([...w.held.keys()].sort()).toEqual([A, B, C])
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "sweep", page: null })
        })

        it("an in-flight DID in the project phase stops the pass without advancing the page", async () => {
            const { w, deps } = world()
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            try {
                w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "project", page: null }
                w.serve(A, C)
                w.standing.set(B, "in-flight")
                await runGraphProjector(deps, 10)
                expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "project", page: null })
                expect(w.held.has(B)).toBe(false)
                expect(warn).toHaveBeenCalledTimes(1)
            } finally {
                warn.mockRestore()
            }
        })

        it("sweep phase deletes every held projection not served, paged across runs", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "sweep", page: null }
            for (const d of [A, B, C, D]) w.held.set(d, projectGraph(d, [], []))
            w.serve(A, C)
            await runGraphProjector(deps, 2)
            expect(w.deletes).toEqual([B])
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "sweep", page: B })
            await runGraphProjector(deps, 2)
            expect(w.deletes).toEqual([B, D])
            expect([...w.held.keys()].sort()).toEqual([A, C])
        })

        it("an in-flight DID in the sweep phase is never deleted and stops the pass", async () => {
            const { w, deps } = world()
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            try {
                w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "sweep", page: null }
                for (const d of [A, B, C]) w.held.set(d, projectGraph(d, [], []))
                w.serve(A)
                w.standing.set(B, "in-flight")
                await runGraphProjector(deps, 10)
                expect(w.deletes).toEqual([])
                expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "sweep", page: null })
                expect(warn).toHaveBeenCalledTimes(1)
            } finally {
                warn.mockRestore()
            }
        })

        it("a cursor past the log's high-water mark starts a rebuild", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "tail", seq: 50 }
            w.serve(A)
            w.row(1, A)
            w.row(2, B)
            await runGraphProjector(deps, 1)
            expect(w.cursor).toMatchObject({ kind: "rebuild", asOfSeq: 2 })
            expect(w.held.has(A)).toBe(true)
        })

        it("a project page is sized to the remaining budget, so it completes and its cursor is saved", async () => {
            const { w, deps } = world({ budget: 2 * PROJECT_STATEMENTS_PER_DID })
            w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "project", page: null }
            w.serve(A, B, C, D)
            await runGraphProjector(deps, 10)
            expect([...w.held.keys()].sort()).toEqual([A, B])
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "project", page: B })
            expect(await runGraphProjector(deps, 10)).toBe(0)
            expect(w.cursor).toEqual({ kind: "rebuild", asOfSeq: 9, phase: "project", page: B })
        })

        it("after the sweep, tailing resumes from the rebuild's asOfSeq", async () => {
            const { w, deps } = world()
            w.cursor = { kind: "rebuild", asOfSeq: 9, phase: "sweep", page: null }
            w.serve(A)
            w.held.set(A, projectGraph(A, [], []))
            await runGraphProjector(deps, 10)
            expect(w.cursor).toEqual({ kind: "tail", seq: 9 })
        })
    })
})
