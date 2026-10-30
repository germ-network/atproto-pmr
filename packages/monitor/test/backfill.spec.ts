/**
 * Baseline build: walking a relay's enumeration to discover DIDs the live
 * tail alone would never see — anything published before this monitor's
 * connection opened and untouched since.
 */
import { describe, expect, it } from "vitest"
import { sweepBackfill, sweepEvidenceRefresh, type BackfillDeps } from "../src/backfill"
import type { ListReposPage } from "../src/list-repos"
import type {
    BackfillProgress,
    EvidenceBackfillProgress,
    IndexedRecord,
    MonitorIndex,
} from "../src/storage"

/** A minimal MonitorIndex — only the members sweepBackfill actually touches. */
function fakeIndex(overrides: Partial<MonitorIndex> = {}): {
    index: MonitorIndex
    revs: Map<string, string>
    owed: string[]
} {
    const revs = new Map<string, string>()
    const owed: string[] = []
    const owedGenerations = new Map<string, number>()
    let progress: BackfillProgress = { done: false, cursor: null }

    const index: MonitorIndex = {
        readCursor: async () => null,
        intake: async () => ({ outcome: "accepted" }),
        owe: async (did) => {
            owed.push(did)
            owedGenerations.set(did, (owedGenerations.get(did) ?? 0) + 1)
        },
        owedGenOf: async (did) => owedGenerations.get(did) ?? null,
        clearPending: async (did) => void owedGenerations.delete(did),
        markAttempted: async () => {},
        isWatched: async () => false,
        complete: async () => {},
        completeDeletion: async () => {},
        completeQuietly: async () => {},
        isDeleted: async () => false,
        duePending: async () => [],
        deferPending: async () => null,
        revOf: async (did) => revs.get(did) ?? null,
        recordsOf: async () => [],
        holderStateOf: async () => null,
        heldDeclarationOf: async () => null,
        recordSeenKey: async () => {},
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

describe("sweepEvidenceRefresh", () => {
    const held = (did: string): IndexedRecord => ({
        did,
        collection: "com.example.declaration",
        rkey: "self",
        rev: `rev-${did}`,
        cid: "bafyreic",
        verifiedWith: "zKey",
    })

    /** Held declarations, paged by DID, with the sweep's members as methods needing `this`. */
    function evidenceIndex(dids: string[], withOwe = true) {
        const refreshed: string[] = []
        const pageCursors: (string | null)[] = []
        const members = {
            progress: { done: false, cursor: null } as EvidenceBackfillProgress,
            refreshed,
            pageCursors,
            async evidenceBackfillPage(afterDid: string | null, limit: number) {
                this.pageCursors.push(afterDid)
                return dids
                    .filter((did) => afterDid === null || did > afterDid)
                    .slice(0, limit)
                    .map(held)
            },
            async readEvidenceBackfillProgress() {
                return this.progress
            },
            async setEvidenceBackfillProgress(p: EvidenceBackfillProgress) {
                this.progress = p
            },
            async oweEvidenceRefresh(did: string, rev: string) {
                this.refreshed.push(`${did}@${rev}`)
            },
        }
        const h = fakeIndex(members)
        if (!withOwe) delete (h.index as Partial<MonitorIndex>).oweEvidenceRefresh
        // The members are copied onto the index, which is their `this`.
        return { ...h, state: h.index as unknown as typeof members }
    }

    it("owes each held declaration through oweEvidenceRefresh, never owe, a page per call", async () => {
        const h = evidenceIndex(["did:a", "did:b", "did:c"])
        expect(await sweepEvidenceRefresh({ index: h.index, limit: 2 })).toEqual({ discovered: 2, done: false })
        expect(await sweepEvidenceRefresh({ index: h.index, limit: 2 })).toEqual({ discovered: 1, done: true })
        expect(h.state.pageCursors).toEqual([null, "did:b"])
        expect(h.state.refreshed).toEqual(["did:a@rev-did:a", "did:b@rev-did:b", "did:c@rev-did:c"])
        expect(h.owed).toEqual([])
    })

    it("pages nothing once done", async () => {
        const h = evidenceIndex(["did:a"])
        await sweepEvidenceRefresh({ index: h.index, limit: 4 })
        expect(h.state.progress).toEqual({ done: true })
        expect(await sweepEvidenceRefresh({ index: h.index, limit: 4 })).toEqual({ discovered: 0, done: true })
        expect(h.state.pageCursors).toEqual([null])
    })

    it("an index without oweEvidenceRefresh is done at once and owes nothing", async () => {
        const h = evidenceIndex(["did:a"], false)
        expect(await sweepEvidenceRefresh({ index: h.index, limit: 4 })).toEqual({ discovered: 0, done: true })
        expect(h.state.pageCursors).toEqual([])
        expect(h.owed).toEqual([])
        expect(h.state.progress).toEqual({ done: false, cursor: null })
    })
})
