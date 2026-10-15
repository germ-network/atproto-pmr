/**
 * A summary stays within one invocation's store reads: its index is built
 * without reading CARs, a response carries at most a page of CARs and says
 * when more remain, and an owner with too many contacts gets the
 * highest-priority ones and is told so.
 */
import { describe, expect, it } from "vitest"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import type { GraphReadResponse } from "../src/read-api"
import type { ReadSigningKey } from "../src/read-signing-key"
import { SNAPSHOT_MAX_AGE_MS } from "../src/snapshot-read"
import {
    SUMMARY_MAX_RECORDS,
    buildSummaryIndex,
    summaryContacts,
    type SummaryHeldEntry,
    type SummaryPageDeps,
} from "../src/summary"

const OWNER = "did:plc:owner"
const NOW = 10_000_000_000
const COLL = "app.example.thing"

const edge = (did: string, rkey = "r", mutual = false) => ({ did, rkey, mutual })
const graphOf = (
    following: GraphReadResponse["following"],
    followers: GraphReadResponse["followers"] = []
): GraphReadResponse => ({ did: OWNER, following, followers })

describe("summaryContacts", () => {
    it("orders the owner, then mutuals, following and followers, each by DID", () => {
        const graph = graphOf(
            [edge("did:plc:f2"), edge("did:plc:m2", "r", true), edge("did:plc:f1"), edge("did:plc:m1", "r", true)],
            [edge("did:plc:g2"), edge("did:plc:g1")]
        )
        expect(summaryContacts(OWNER, graph, 100)).toEqual({
            dids: [OWNER, "did:plc:m1", "did:plc:m2", "did:plc:f1", "did:plc:f2", "did:plc:g1", "did:plc:g2"],
            truncated: false,
        })
    })

    it("a DID in several groups appears once, in its highest group", () => {
        const graph = graphOf(
            [edge("did:plc:a"), edge("did:plc:b", "r", true), edge("did:plc:b", "r2")],
            [edge("did:plc:a"), edge("did:plc:b", "r", true), edge(OWNER)]
        )
        expect(summaryContacts(OWNER, graph, 100).dids).toEqual([OWNER, "did:plc:b", "did:plc:a"])
    })

    it("cuts at maxContacts and sets truncated; at or under it, it is not set", () => {
        const graph = graphOf([edge("did:plc:a"), edge("did:plc:b"), edge("did:plc:c")])
        expect(summaryContacts(OWNER, graph, 3)).toEqual({
            dids: [OWNER, "did:plc:a", "did:plc:b"],
            truncated: true,
        })
        expect(summaryContacts(OWNER, graph, 4).truncated).toBe(false)
        expect(summaryContacts(OWNER, graph, 5).truncated).toBe(false)
    })
})

function indexWorld(
    options: {
        graph?: GraphReadResponse | null
        watched?: SummaryPageDeps["watched"]
        held?: (SummaryHeldEntry | null)[] | ((did: string, collection: string, rkey: string) => SummaryHeldEntry | null)
        keys?: (did: string) => ReadSigningKey | undefined
    } = {}
) {
    const asked: { did: string; collection: string; rkey: string }[][] = []
    const keyReads: string[][] = []
    const lapses: string[] = []
    const recordReads: string[] = []
    const watched = options.watched ?? [{ collection: COLL, rkey: "self" }]
    const deps: SummaryPageDeps = {
        projections: { get: async () => (options.graph === undefined ? graphOf([]) : options.graph) },
        index: {
            entries: async (refs) => {
                asked.push([...refs])
                const held = options.held
                return refs.map((r) =>
                    typeof held === "function" ? held(r.did, r.collection, r.rkey) : (held?.[0] ?? null)
                )
            },
        },
        records: {
            get: async (did, c, r) => {
                recordReads.push(`${did}/${c}/${r}`)
                return null
            },
        },
        signingKeys: {
            keysFor: async (dids) => {
                keyReads.push([...dids])
                return new Map(
                    dids.flatMap((d) => {
                        const k = options.keys ? options.keys(d) : ({ kind: "trusted", key: "zKey" } as const)
                        return k === undefined ? [] : [[d, k] as const]
                    })
                )
            },
        },
        watched,
        onLapse: (did) => lapses.push(did),
        nowMs: () => NOW,
    }
    return { deps, asked, keyReads, lapses, recordReads }
}

const held = (did: string, collection = COLL, rkey = "self", over: Partial<SummaryHeldEntry> = {}): SummaryHeldEntry => ({
    did,
    collection,
    rkey,
    cid: `cid-${did}`,
    verifiedWith: "zKey",
    freshAtMs: NOW,
    ...over,
})

describe("buildSummaryIndex", () => {
    it("is null when the owner has no projection", async () => {
        const w = indexWorld({ graph: null })
        expect(await buildSummaryIndex(OWNER, w.deps)).toBeNull()
        expect(w.asked).toEqual([])
    })

    it("caps contacts at SUMMARY_MAX_RECORDS over the watched count", async () => {
        const many = Array.from({ length: 5_000 }, (_, i) => edge(`did:plc:c${String(i).padStart(5, "0")}`))
        const watched = [
            { collection: COLL, rkey: "self" },
            { collection: COLL, rkey: "other" },
            { collection: COLL, rkey: "third" },
        ]
        const w = indexWorld({ graph: graphOf(many), watched })
        const built = await buildSummaryIndex(OWNER, w.deps)
        const cap = Math.floor(SUMMARY_MAX_RECORDS / 3)
        expect(w.asked[0]).toHaveLength(cap * 3)
        expect(built!.truncated).toBe(true)
        const small = indexWorld({ graph: graphOf([edge("did:plc:a")]) })
        expect((await buildSummaryIndex(OWNER, small.deps))!.truncated).toBe(false)
    })

    it("reads entries for every covered contact x watched record, and no CAR", async () => {
        const watched = [
            { collection: COLL, rkey: "self" },
            { collection: COLL, rkey: "other" },
        ]
        const w = indexWorld({ graph: graphOf([edge("did:plc:a")], [edge("did:plc:b")]), watched })
        await buildSummaryIndex(OWNER, w.deps)
        expect(w.asked).toHaveLength(1)
        expect(w.asked[0]!.map((r) => `${r.did}/${r.rkey}`)).toEqual([
            `${OWNER}/self`,
            `${OWNER}/other`,
            "did:plc:a/self",
            "did:plc:a/other",
            "did:plc:b/self",
            "did:plc:b/other",
        ])
        expect(w.recordReads).toEqual([])
    })

    it("leaves out unheld, unverified and rotation-failed records", async () => {
        const w = indexWorld({
            graph: graphOf([edge("did:plc:a"), edge("did:plc:b"), edge("did:plc:c"), edge("did:plc:d"), edge("did:plc:e")]),
            watched: [
                { collection: DECLARATION_COLLECTION_NSID, rkey: "self" },
                { collection: COLL, rkey: "self" },
            ],
            held: (did, collection) =>
                did === "did:plc:a"
                    ? null
                    : did === "did:plc:c"
                      ? held(did, collection, "self", { verifiedWith: "zOld", freshAtMs: 0 })
                      : held(did, collection),
            keys: (did) =>
                did === "did:plc:d" ? { kind: "unknown" } : did === "did:plc:e" ? undefined : { kind: "trusted", key: "zKey" },
        })
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(built!.index.records.map((r) => r.did)).toEqual(["did:plc:b", "did:plc:b", OWNER, OWNER])
        // A rotated-away declaration, however stale, is not reported: it is not in the index.
        expect(w.lapses).toEqual([])
        // Keys are read for held contacts only.
        expect(w.keyReads).toEqual([[OWNER, "did:plc:b", "did:plc:c", "did:plc:d", "did:plc:e"]])
    })

    it("reports a held declaration past SNAPSHOT_MAX_AGE_MS to onLapse and still includes it", async () => {
        const w = indexWorld({
            graph: graphOf([edge("did:plc:a"), edge("did:plc:b")]),
            watched: [
                { collection: DECLARATION_COLLECTION_NSID, rkey: "self" },
                { collection: COLL, rkey: "self" },
            ],
            held: (did, collection) =>
                held(did, collection, "self", {
                    freshAtMs: did === "did:plc:a" ? NOW - SNAPSHOT_MAX_AGE_MS - 1 : NOW - SNAPSHOT_MAX_AGE_MS,
                }),
        })
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(w.lapses).toEqual(["did:plc:a"])
        expect(built!.index.records.some((r) => r.did === "did:plc:a" && r.collection === DECLARATION_COLLECTION_NSID)).toBe(true)
        // A non-declaration record past the age is not a lapse.
        const other = indexWorld({
            held: (did) => held(did, COLL, "self", { freshAtMs: 0 }),
        })
        await buildSummaryIndex(OWNER, other.deps)
        expect(other.lapses).toEqual([])
    })

    it("never requests a re-check", async () => {
        const w = indexWorld({ held: (did) => held(did, DECLARATION_COLLECTION_NSID, "self", { freshAtMs: 0 }), watched: [{ collection: DECLARATION_COLLECTION_NSID, rkey: "self" }] })
        await buildSummaryIndex(OWNER, w.deps)
        expect(w.lapses).toEqual([OWNER])
    })
})

describe("readSummaryPage", () => {
    it.todo("with no base, the page is full with no removals")
    it.todo("carries at most limit changed records and sets more when others remain")
    it.todo("pages changed records in (did, collection, rkey) order, the owner's first")
    it.todo("delivered has more set exactly when the page does")
    it.todo("delivered is base minus removals plus the delivered records, with the current graph")
    it.todo("a delivered record's entry is taken from its own CAR read, so bytes match the index")
    it.todo("a record gone or no longer servable at its CAR read is reported removed")
    it.todo("the graph is carried on the first page it changed on, and null after")
    it.todo("paging from each delivered index converges to current with more unset")
})

describe("summary delta codec", () => {
    it.todo("more and truncated round-trip")
    it.todo("a body without more or truncated decodes them as false")
})
