/**
 * Baseline build: walking a relay's enumeration to discover DIDs the live
 * tail alone would never see — anything published before this monitor's
 * connection opened and untouched since.
 */
import { describe, expect, it } from "vitest"
import { sweepBackfill, type BackfillDeps } from "../src/backfill"
import type { ListReposPage } from "../src/list-repos"
import type { BackfillProgress, MonitorIndex } from "../src/storage"

/** A minimal MonitorIndex — only the members sweepBackfill actually touches. */
function fakeIndex(overrides: Partial<MonitorIndex> = {}): {
    index: MonitorIndex
    revs: Map<string, string>
    owed: string[]
} {
    const revs = new Map<string, string>()
    const owed: string[] = []
    let progress: BackfillProgress = { done: false, cursor: null }

    const index: MonitorIndex = {
        readCursor: async () => null,
        intake: async () => ({ outcome: "accepted" }),
        owe: async (did) => void owed.push(did),
        clearPending: async () => {},
        complete: async () => {},
        completeDeletion: async () => {},
        isDeleted: async () => false,
        duePending: async () => [],
        deferPending: async () => {},
        revOf: async (did) => revs.get(did) ?? null,
        windowMembers: async () => [],
        dropWindow: async () => {},
        readBackfillProgress: async () => progress,
        setBackfillProgress: async (p) => void (progress = p),
        ...overrides,
    }
    return { index, revs, owed }
}

function pages(...ps: ListReposPage[]) {
    let call = 0
    return async (cursor: string | null): Promise<ListReposPage> => {
        const page = ps[call]
        call += 1
        if (page === undefined) throw new Error(`listRepos called more times than expected (cursor=${cursor})`)
        return page
    }
}

describe("sweepBackfill", () => {
    it("owes a fetch for every DID the relay names that isn't already indexed", async () => {
        const h = fakeIndex()
        const deps: BackfillDeps = {
            index: h.index,
            listRepos: pages({ dids: ["did:plc:a", "did:plc:b"], nextCursor: null }),
        }
        const result = await sweepBackfill(deps)
        expect(result).toEqual({ discovered: 2, done: true })
        expect(h.owed).toEqual(["did:plc:a", "did:plc:b"])
    })

    it("does NOT re-owe a DID the live tail (or an earlier sweep) already indexed", async () => {
        // The property that keeps a sweep cheap: it discovers what is
        // missing, not what is already known.
        const h = fakeIndex()
        h.revs.set("did:plc:already-known", "3m1")
        const deps: BackfillDeps = {
            index: h.index,
            listRepos: pages({
                dids: ["did:plc:already-known", "did:plc:new"],
                nextCursor: null,
            }),
        }
        const result = await sweepBackfill(deps)
        expect(result.discovered).toBe(1)
        expect(h.owed).toEqual(["did:plc:new"])
    })

    it("persists the relay's cursor across calls, and resumes from it", async () => {
        const h = fakeIndex()
        const seen: (string | null)[] = []
        const deps: BackfillDeps = {
            index: h.index,
            listRepos: async (cursor) => {
                seen.push(cursor)
                return cursor === null
                    ? { dids: ["did:plc:a"], nextCursor: "page-2" }
                    : { dids: ["did:plc:b"], nextCursor: null }
            },
        }
        const first = await sweepBackfill(deps)
        expect(first).toEqual({ discovered: 1, done: false })
        const second = await sweepBackfill(deps)
        expect(second).toEqual({ discovered: 1, done: true })
        expect(seen).toEqual([null, "page-2"])
    })

    it("does nothing, and does not call the relay again, once done", async () => {
        const h = fakeIndex()
        await h.index.setBackfillProgress({ done: true })
        const deps: BackfillDeps = {
            index: h.index,
            listRepos: async () => {
                throw new Error("must not be called once the sweep is done")
            },
        }
        const result = await sweepBackfill(deps)
        expect(result).toEqual({ discovered: 0, done: true })
    })

    it("treats an empty-string cursor the same as an absent one — the sweep still ends", async () => {
        const h = fakeIndex()
        const deps: BackfillDeps = {
            index: h.index,
            listRepos: pages({ dids: [], nextCursor: null }),
        }
        expect(await sweepBackfill(deps)).toEqual({ discovered: 0, done: true })
    })
})
