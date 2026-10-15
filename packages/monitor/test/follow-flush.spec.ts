import { describe, expect, it } from "vitest"
import {
    coalesceEdgeOps,
    drainRecounts,
    flushEdgeOps,
    flushLimit,
    flushStatements,
    reconcileOwnerFollowers,
    recountOwnerFollowers,
    recountStatements,
    type EdgeFlushDeps,
    type OwnerFollowerDeps,
    type RecountQueueIndex,
} from "../src/follow-flush"
import type { EdgeOp } from "../src/follow-stream"
import type { BlockEdgeWriter, EdgeRef, FollowEdgeWriter, StatementBudget } from "../src/storage"
import type { BlockEdge, FollowEdge } from "@germ-network/atproto-pmr-core"

const create = (seq: number, follower: string, rkey: string, subject = "did:s"): EdgeOp => ({
    seq,
    collection: "follow",
    kind: "create",
    follower,
    rkey,
    subject,
    rev: "r",
    cursor: "1",
})
const blockCreate = (seq: number, blocker: string, rkey: string, subject = "did:s"): EdgeOp => ({
    ...create(seq, blocker, rkey, subject),
    collection: "block",
})
const blockDel = (seq: number, blocker: string, rkey: string): EdgeOp => ({
    ...del(seq, blocker, rkey),
    collection: "block",
})
const del = (seq: number, follower: string, rkey: string): EdgeOp => ({
    seq,
    collection: "follow",
    kind: "delete",
    follower,
    rkey,
    rev: "r",
    cursor: "1",
})

describe("coalesceEdgeOps", () => {
    it("keeps the last op per (follower, rkey) and the largest seq read", () => {
        const out = coalesceEdgeOps([
            create(1, "a", "1", "did:x"),
            create(2, "a", "1", "did:y"),
            create(3, "b", "1"),
            del(4, "b", "1"),
            create(5, "c", "9"),
        ])
        expect(out.creates).toEqual([
            { follower: "a", rkey: "1", subject: "did:y" },
            { follower: "c", rkey: "9", subject: "did:s" },
        ])
        expect(out.deletes).toEqual([{ follower: "b", rkey: "1" }])
        expect(out.throughSeq).toBe(5)
    })

    it("a delete then a re-create of one rkey coalesces to the create", () => {
        const out = coalesceEdgeOps([del(1, "a", "1"), create(2, "a", "1")])
        expect(out.creates).toHaveLength(1)
        expect(out.deletes).toEqual([])
    })

    it("an empty read has nothing to flush", () => {
        expect(coalesceEdgeOps([])).toEqual({
            creates: [],
            deletes: [],
            blockCreates: [],
            blockDeletes: [],
            throughSeq: 0,
        })
    })
})

describe("coalesceEdgeOps — blocks", () => {
    it("a follow op and a block op sharing an rkey neither coalesce nor cancel", () => {
        const out = coalesceEdgeOps([
            create(1, "a", "1", "did:f"),
            blockCreate(2, "a", "1", "did:b"),
            blockDel(3, "a", "1"),
        ])
        expect(out.creates).toEqual([{ follower: "a", rkey: "1", subject: "did:f" }])
        expect(out.blockCreates).toEqual([])
        expect(out.blockDeletes).toEqual([{ blocker: "a", rkey: "1" }])
        expect(out.deletes).toEqual([])
    })
})

describe("statement costs", () => {
    it("flushStatements is 2 per 25 creates and 1 per 25 deletes, rounded up", () => {
        expect(flushStatements(0, 0, 0, 0)).toBe(0)
        expect(flushStatements(1, 0, 0, 0)).toBe(2)
        expect(flushStatements(25, 0, 0, 0)).toBe(2)
        expect(flushStatements(26, 0, 0, 0)).toBe(4)
        expect(flushStatements(0, 1, 0, 0)).toBe(1)
        expect(flushStatements(0, 26, 0, 0)).toBe(2)
        expect(flushStatements(26, 26, 0, 0)).toBe(6)
    })

    it("flushStatements counts one per 25 block creates and one per 25 block deletes", () => {
        expect(flushStatements(0, 0, 1, 0)).toBe(1)
        expect(flushStatements(0, 0, 26, 25)).toBe(3)
        expect(flushStatements(26, 1, 26, 26)).toBe(4 + 1 + 2 + 2)
    })

    it("recountStatements is one per 50 subjects, rounded up", () => {
        expect(recountStatements(0)).toBe(0)
        expect(recountStatements(1)).toBe(1)
        expect(recountStatements(50)).toBe(1)
        expect(recountStatements(51)).toBe(2)
    })

    it("flushLimit sizes a read whose worst case fits, whatever the follow and block split", () => {
        expect(flushLimit(0)).toBe(0)
        expect(flushLimit(4)).toBe(0)
        for (const remaining of [5, 8, 100, 1000]) {
            const n = flushLimit(remaining)
            expect(n).toBeGreaterThan(0)
            // A plain comparison: an expect() per case made this loop exceed the default timeout on CI.
            const overBudget: number[][] = []
            for (let c = 0; c <= n; c++) {
                for (let d = 0; c + d <= n; d += 1 + Math.floor(n / 12)) {
                    for (let bc = 0; c + d + bc <= n; bc += 1 + Math.floor(n / 12)) {
                        if (flushStatements(c, d, bc, n - c - d - bc) > remaining) {
                            overBudget.push([c, d, bc, n - c - d - bc])
                        }
                    }
                }
            }
            expect(overBudget).toEqual([])
            expect(flushStatements(n - 3, 1, 1, 1)).toBeLessThanOrEqual(remaining)
        }
        expect(flushLimit(5)).toBe(25)
        expect(flushStatements(22, 1, 1, 1)).toBe(5)
    })
})

function budgetOf(limit: number): StatementBudget {
    let remaining = limit
    return {
        get remaining() {
            return remaining
        },
        take(count) {
            if (count > remaining) return false
            remaining -= count
            return true
        },
    }
}

/** A writer over an in-memory edge table keyed by (follower, rkey). */
function memoryEdges(initial: FollowEdge[] = []) {
    const rows = new Map<string, FollowEdge & { gen: number }>()
    const key = (f: string, r: string) => `${f}\u0000${r}`
    for (const e of initial) rows.set(key(e.follower, e.rkey), { ...e, gen: 0 })
    const calls: string[] = []
    let failNext = false
    const edges = {
        async putEdges(es: readonly FollowEdge[], gen: number) {
            calls.push("put")
            if (failNext) {
                failNext = false
                throw new Error("d1 down")
            }
            const subjects = new Set<string>()
            for (const e of es) {
                const old = rows.get(key(e.follower, e.rkey))
                if (old) subjects.add(old.subject)
                rows.set(key(e.follower, e.rkey), { ...e, gen })
                subjects.add(e.subject)
            }
            return { subjects: [...subjects] }
        },
        async deleteEdges(refs: readonly EdgeRef[]) {
            calls.push("delete")
            const subjects = new Set<string>()
            for (const r of refs) {
                const old = rows.get(key(r.follower, r.rkey))
                if (!old) continue
                subjects.add(old.subject)
                rows.delete(key(r.follower, r.rkey))
            }
            return { subjects: [...subjects] }
        },
        async followersOf(subjects: readonly string[]) {
            const out = new Map<string, string[]>()
            for (const e of rows.values()) {
                if (!subjects.includes(e.subject)) continue
                out.set(e.subject, [...(out.get(e.subject) ?? []), e.follower])
            }
            return out
        },
    }
    return {
        edges: edges as unknown as FollowEdgeWriter,
        rows,
        calls,
        failNext: () => (failNext = true),
    }
}

function memoryOps(initial: EdgeOp[]) {
    let log = [...initial]
    const dropped: { throughSeq: number; subjects: readonly string[] }[] = []
    return {
        append: (op: EdgeOp) => log.push(op),
        dropped,
        get log() {
            return log
        },
        ops: {
            async edgeOps(limit: number) {
                return log.slice(0, limit)
            },
            async dropEdgeOps(throughSeq: number, subjects: readonly string[]) {
                dropped.push({ throughSeq, subjects })
                log = log.filter((o) => o.seq > throughSeq)
            },
            async currentGen() {
                return 7
            },
        },
    }
}

/** A block writer over an in-memory table keyed by (blocker, rkey). */
function memoryBlocks() {
    const rows = new Map<string, BlockEdge & { gen: number }>()
    const key = (blocker: string, rkey: string) => `${blocker}\u0000${rkey}`
    const writer: BlockEdgeWriter = {
        async putBlocks(blocks, gen) {
            for (const b of blocks) rows.set(key(b.blocker, b.rkey), { ...b, gen })
        },
        async deleteBlocks(refs) {
            for (const r of refs) rows.delete(key(r.blocker, r.rkey))
        },
        async sweepBlocks() {},
    }
    return { writer, rows }
}

const flushDeps = (
    log: ReturnType<typeof memoryOps>,
    store: ReturnType<typeof memoryEdges>,
    inInterest: (did: string) => boolean = () => true,
    blocks: ReturnType<typeof memoryBlocks> = memoryBlocks()
): EdgeFlushDeps => ({
    ops: log.ops,
    edges: store.edges,
    blocks: blocks.writer,
    budget: budgetOf(1000),
    interest: { inInterest: async (did) => inInterest(did) },
})

describe("flushEdgeOps — blocks", () => {
    it("writes block creates and deletes through the block writer and queues no re-count", async () => {
        const log = memoryOps([
            blockCreate(1, "a", "1", "did:x"),
            blockCreate(2, "a", "2", "did:y"),
            blockDel(3, "a", "1"),
            blockCreate(4, "b", "1", "did:z"),
        ])
        const store = memoryEdges()
        const blocks = memoryBlocks()
        expect(await flushEdgeOps(flushDeps(log, store, () => true, blocks), 10)).toBe(4)
        expect([...blocks.rows.values()]).toEqual([
            { blocker: "a", rkey: "2", subject: "did:y", gen: 7 },
            { blocker: "b", rkey: "1", subject: "did:z", gen: 7 },
        ])
        expect(store.calls).toEqual([])
        expect(log.dropped).toEqual([{ throughSeq: 4, subjects: [] }])
    })

    it("a block create by a blocker no longer in interest is not written, and clears the block it would have replaced", async () => {
        const log = memoryOps([blockCreate(1, "gone", "1", "did:new"), blockCreate(2, "here", "1")])
        const blocks = memoryBlocks()
        await blocks.writer.putBlocks([{ blocker: "gone", rkey: "1", subject: "did:old" }], 1)
        await flushEdgeOps(flushDeps(log, memoryEdges(), (d) => d === "here", blocks), 10)
        expect([...blocks.rows.values()].map((r) => r.blocker)).toEqual(["here"])
    })
})

describe("flushEdgeOps", () => {
    it("writes creates at the current generation, then drops through the largest seq read with the subjects", async () => {
        const log = memoryOps([create(1, "a", "1", "did:x"), create(2, "a", "2", "did:y")])
        const store = memoryEdges()
        expect(await flushEdgeOps(flushDeps(log, store), 10)).toBe(2)
        expect([...store.rows.values()].map((r) => r.gen)).toEqual([7, 7])
        expect(log.dropped).toHaveLength(1)
        expect(log.dropped[0]!.throughSeq).toBe(2)
        expect([...log.dropped[0]!.subjects].sort()).toEqual(["did:x", "did:y"])
    })

    it("a failed batch leaves the whole prefix in the log", async () => {
        const log = memoryOps([create(1, "a", "1"), del(2, "b", "1")])
        const store = memoryEdges()
        store.failNext()
        await expect(flushEdgeOps(flushDeps(log, store), 10)).rejects.toThrow("d1 down")
        expect(log.log).toHaveLength(2)
        expect(log.dropped).toEqual([])
    })

    it("an op appended during the D1 await survives the drop", async () => {
        const log = memoryOps([create(1, "a", "1")])
        const store = memoryEdges()
        const put = store.edges.putEdges.bind(store.edges)
        store.edges.putEdges = async (es, gen) => {
            log.append(create(2, "a", "2"))
            return put(es, gen)
        }
        await flushEdgeOps(flushDeps(log, store), 10)
        expect(log.log.map((o) => o.seq)).toEqual([2])
    })

    it("a create by a follower no longer in interest is not written, and clears any edge it would have replaced", async () => {
        const log = memoryOps([create(1, "gone", "1", "did:new"), create(2, "here", "1", "did:y")])
        const store = memoryEdges([{ follower: "gone", rkey: "1", subject: "did:old" }])
        await flushEdgeOps(flushDeps(log, store, (d) => d === "here"), 10)
        expect([...store.rows.values()].map((r) => r.follower)).toEqual(["here"])
        expect([...log.dropped[0]!.subjects].sort()).toEqual(["did:old", "did:y"])
    })

    it("a delete of an absent edge is a no-op that still drops", async () => {
        const log = memoryOps([del(1, "a", "1")])
        const store = memoryEdges()
        expect(await flushEdgeOps(flushDeps(log, store), 10)).toBe(1)
        expect(log.dropped[0]!.subjects).toEqual([])
    })

    it("an empty log sends nothing", async () => {
        const log = memoryOps([])
        const store = memoryEdges()
        expect(await flushEdgeOps(flushDeps(log, store), 10)).toBe(0)
        expect(store.calls).toEqual([])
        expect(log.dropped).toEqual([])
    })
})

function ownerDeps(opts: {
    policy?: "registered" | "everyone"
    owners: string[]
    edges: ReturnType<typeof memoryEdges>
}) {
    const sets: [string, number][] = []
    const deps: OwnerFollowerDeps = {
        edges: opts.edges.edges,
        interest: {
            interestPolicy: () => opts.policy ?? "registered",
            isGraphOwner: async (did) => opts.owners.includes(did),
            setOwnerFollowers: async (did, count) => void sets.push([did, count]),
        },
        nowMs: () => 5,
    }
    return { deps, sets }
}

describe("recountOwnerFollowers", () => {
    it("counts distinct followers that are graph owners, and 0 for an unfollowed subject", async () => {
        const store = memoryEdges([
            { follower: "o1", rkey: "1", subject: "did:s" },
            { follower: "o1", rkey: "2", subject: "did:s" },
            { follower: "o2", rkey: "1", subject: "did:s" },
            { follower: "plain", rkey: "1", subject: "did:s" },
        ])
        const { deps, sets } = ownerDeps({ owners: ["o1", "o2"], edges: store })
        await recountOwnerFollowers(deps, ["did:s", "did:none"])
        expect(sets).toEqual([
            ["did:s", 2],
            ["did:none", 0],
        ])
    })

    it("is a no-op under everyone", async () => {
        const store = memoryEdges([{ follower: "o1", rkey: "1", subject: "did:s" }])
        const { deps, sets } = ownerDeps({ policy: "everyone", owners: ["o1"], edges: store })
        await recountOwnerFollowers(deps, ["did:s"])
        expect(sets).toEqual([])
    })
})

function memoryQueue(initial: string[]) {
    const rows = new Map(initial.map((d, i) => [d, i + 1]))
    const queue: RecountQueueIndex = {
        async queueRecount() {},
        async dueRecounts(limit) {
            return [...rows].slice(0, limit).map(([did, queuedAt]) => ({ did, queuedAt }))
        },
        async clearRecounts(entries) {
            for (const e of entries) if (rows.get(e.did) === e.queuedAt) rows.delete(e.did)
        },
    }
    return { queue, rows }
}

describe("drainRecounts", () => {
    it("re-counts as many queued subjects as the budget covers and clears exactly those", async () => {
        const dids = Array.from({ length: 120 }, (_, i) => `did:s${i}`)
        const store = memoryEdges()
        const { deps, sets } = ownerDeps({ owners: [], edges: store })
        const q = memoryQueue(dids)
        // Two statements cover 100 subjects.
        const drained = await drainRecounts({ ...deps, queue: q.queue, budget: budgetOf(2) }, 1000)
        expect(drained).toBe(100)
        expect(sets).toHaveLength(100)
        expect([...q.rows.keys()]).toEqual(dids.slice(100))
    })

    it("an entry re-queued during the await stays queued", async () => {
        const store = memoryEdges()
        const { deps } = ownerDeps({ owners: [], edges: store })
        const q = memoryQueue(["did:a"])
        const followersOf = store.edges.followersOf.bind(store.edges)
        store.edges.followersOf = async (s) => {
            q.rows.set("did:a", 99)
            return followersOf(s)
        }
        await drainRecounts({ ...deps, queue: q.queue, budget: budgetOf(10) }, 10)
        expect(q.rows.get("did:a")).toBe(99)
    })

    it("does nothing under everyone or with no budget", async () => {
        const store = memoryEdges()
        const q = memoryQueue(["did:a"])
        const every = ownerDeps({ policy: "everyone", owners: [], edges: store })
        expect(await drainRecounts({ ...every.deps, queue: q.queue, budget: budgetOf(10) }, 10)).toBe(0)
        const reg = ownerDeps({ owners: [], edges: store })
        expect(await drainRecounts({ ...reg.deps, queue: q.queue, budget: budgetOf(0) }, 10)).toBe(0)
        expect(q.rows.size).toBe(1)
    })
})

describe("reconcileOwnerFollowers", () => {
    const followed = (dids: string[]) => ({
        async ownerFollowed(cursor: string | null, limit: number) {
            const rest = dids.filter((d) => cursor === null || d > cursor)
            const page = rest.slice(0, limit)
            return { dids: page, cursor: rest.length > limit ? page[page.length - 1]! : null }
        },
    })

    it("re-counts a page and returns the next cursor, null when the pass is done", async () => {
        const store = memoryEdges()
        const { deps, sets } = ownerDeps({ owners: [], edges: store })
        const f = followed(["a", "b", "c"])
        const run = (cursor: string | null) =>
            reconcileOwnerFollowers({ ...deps, followed: f, budget: budgetOf(10) }, cursor, 2)
        expect(await run(null)).toBe("b")
        expect(await run("b")).toBeNull()
        expect(sets.map(([d]) => d)).toEqual(["a", "b", "c"])
    })

    it("is a no-op under everyone", async () => {
        const store = memoryEdges()
        const { deps, sets } = ownerDeps({ policy: "everyone", owners: [], edges: store })
        const next = await reconcileOwnerFollowers(
            { ...deps, followed: followed(["a"]), budget: budgetOf(10) },
            null,
            5
        )
        expect(next).toBeNull()
        expect(sets).toEqual([])
    })
})
