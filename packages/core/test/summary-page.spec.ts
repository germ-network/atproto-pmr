/**
 * A summary stays within one invocation's store reads: its index is built
 * without reading CARs, a response carries at most a page of CARs and says
 * when more remain, and an owner with too many contacts gets the
 * highest-priority ones and is told so.
 */
import { describe, expect, it } from "vitest"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import type { OwnerGraph } from "../src/owner-graph"
import type { ReadSigningKey } from "../src/read-signing-key"
import { SNAPSHOT_MAX_AGE_MS } from "../src/snapshot-read"
import {
    CLOCK_DISCONTINUITY_HOLD_MS,
    CLOCK_DISCONTINUITY_THRESHOLD_MS,
    SUMMARY_DELTA_KEYS,
    SUMMARY_MAX_RECORDS,
    buildSummaryIndex,
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    readSummaryPage,
    summaryContacts,
    wallClockMonitor,
    type SummaryDelta,
    type SummaryHeldEntry,
    type SummaryIndex,
    type SummaryIndexEntry,
    type SummaryPageDeps,
} from "../src/summary"
import type { SnapshotEvidence } from "../src/summary-evidence-contract"
import { encodeCose, type CoseValue } from "../src/cose/cbor"

const OWNER = "did:plc:owner"
const NOW = 10_000_000_000
const COLL = "app.example.thing"

const edge = (did: string, mutual = false) => ({ did, mutual })
const graphOf = (
    following: OwnerGraph["following"],
    followers: OwnerGraph["followers"] = []
): OwnerGraph => ({ did: OWNER, following, followers })

describe("summaryContacts", () => {
    it("orders the owner, then mutuals, following and followers, each by DID", () => {
        const graph = graphOf(
            [edge("did:plc:f2"), edge("did:plc:m2", true), edge("did:plc:f1"), edge("did:plc:m1", true)],
            [edge("did:plc:g2"), edge("did:plc:g1")]
        )
        expect(summaryContacts(OWNER, graph, 100)).toEqual({
            dids: [OWNER, "did:plc:m1", "did:plc:m2", "did:plc:f1", "did:plc:f2", "did:plc:g1", "did:plc:g2"],
            truncated: false,
        })
    })

    it("a DID in several groups appears once, in its highest group", () => {
        const graph = graphOf(
            [edge("did:plc:a"), edge("did:plc:b", true), edge("did:plc:b")],
            [edge("did:plc:a"), edge("did:plc:b", true), edge(OWNER)]
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
        graph?: OwnerGraph | null
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
        getFirehoseCoverage: async () => null,
        getPlcCoverage: async () => null,
        graph: { ownGraph: async () => (options.graph === undefined ? graphOf([]) : options.graph) },
        blocks: { ownBlocks: async () => [] },
        senderGraph: { forSender: async () => new Map() },
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
    it("is null when the owner's graph is not served", async () => {
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

const refOf = (did: string, rkey = "self", collection = COLL) => ({ did, collection, rkey })
const entryOf = (did: string, cid: string, rkey = "self", verifiedWith = "zKey"): SummaryIndexEntry => ({
    ...refOf(did, rkey),
    cid,
    verifiedWith,
    commitCid: null,
    rev: null,
    evidenceState: null,
})
const indexOf = (records: ReturnType<typeof entryOf>[], more?: boolean): SummaryIndex => ({
    owner: OWNER,
    ownBlocks: [],
    records,
    verdicts: [],
    evidenceSchema: 1,
    permissionRecencySchema: 1,
    ...(more ? { more } : {}),
})

/** A store holding `held` as (did/rkey -> snapshot); the CAR is the entry's cid bytes. */
function pageWorld(
    heldEntries: ReturnType<typeof entryOf>[],
    options: {
        keys?: (did: string) => ReadSigningKey | undefined
        gone?: Set<string>
        recordFor?: (e: ReturnType<typeof entryOf>) => ReturnType<typeof entryOf>
    } = {}
) {
    const reads: string[] = []
    const deps: Pick<SummaryPageDeps, "records" | "signingKeys"> = {
        records: {
            get: async (did, collection, rkey) => {
                reads.push(`${did}/${rkey}`)
                if (options.gone?.has(`${did}/${rkey}`)) return null
                const found = heldEntries.find((e) => e.did === did && e.rkey === rkey && e.collection === collection)
                if (!found) return null
                const e = options.recordFor ? options.recordFor(found) : found
                return {
                    car: new TextEncoder().encode(`car:${e.cid}`),
                    freshAtMs: NOW,
                    verifiedWith: e.verifiedWith,
                    rev: "3k",
                    cid: e.cid,
                    commitCid: e.commitCid ?? null,
                    evidence: e.evidenceState ?? null,
                }
            },
        },
        signingKeys: {
            keysFor: async (dids) =>
                new Map(
                    dids.flatMap((d) => {
                        const k = options.keys ? options.keys(d) : ({ kind: "trusted", key: "zKey" } as const)
                        return k === undefined ? [] : [[d, k] as const]
                    })
                ),
        },
    }
    return { deps, reads }
}

const carText = (r: { car: Uint8Array }) => new TextDecoder().decode(r.car)

describe("readSummaryPage", () => {
    it("with no base, the page is full with no removals", async () => {
        const current = indexOf([entryOf("did:plc:a", "c1")])
        const w = pageWorld(current.records)
        const { page, delivered } = await readSummaryPage(null, current, w.deps, 10)
        expect(page).toMatchObject({ full: true, removed: [], more: false })
        expect(page.records.map((r) => r.did)).toEqual(["did:plc:a"])
        expect(delivered.records).toEqual(current.records)
    })

    it("carries at most limit changed records and sets more when others remain", async () => {
        const current = indexOf([1, 2, 3, 4, 5].map((i) => entryOf(`did:plc:d${i}`, `c${i}`)))
        const w = pageWorld(current.records)
        const { page } = await readSummaryPage(null, current, w.deps, 2)
        expect(page.records).toHaveLength(2)
        expect(page.more).toBe(true)
        expect(w.reads).toHaveLength(2)
        const exact = await readSummaryPage(null, current, pageWorld(current.records).deps, 5)
        expect(exact.page.more).toBe(false)
    })

    it("pages changed records in (did, collection, rkey) order, the owner's first", async () => {
        const records = [
            entryOf("did:plc:b", "c1", "z"),
            entryOf("did:plc:b", "c2", "a"),
            entryOf("did:plc:a", "c3"),
            entryOf(OWNER, "c4"),
        ]
        const current = indexOf(records)
        const { page } = await readSummaryPage(null, current, pageWorld(records).deps, 10)
        expect(page.records.map((r) => `${r.did}/${r.rkey}`)).toEqual([
            `${OWNER}/self`,
            "did:plc:a/self",
            "did:plc:b/a",
            "did:plc:b/z",
        ])
    })

    it("delivered has more set exactly when the page does", async () => {
        const current = indexOf([entryOf("did:plc:a", "c1"), entryOf("did:plc:b", "c2")])
        const more = await readSummaryPage(null, current, pageWorld(current.records).deps, 1)
        expect(more.page.more).toBe(true)
        expect(more.delivered.more).toBe(true)
        const done = await readSummaryPage(null, current, pageWorld(current.records).deps, 2)
        expect(done.page.more).toBe(false)
        expect(done.delivered.more).toBeUndefined()
    })

    it("delivered is base minus removals plus the delivered records", async () => {
        const base = indexOf([
            entryOf("did:plc:keep", "k1"),
            entryOf("did:plc:change", "v1"),
            entryOf("did:plc:gone", "g1"),
        ])
        const current = indexOf([
            entryOf("did:plc:added", "n1"),
            entryOf("did:plc:change", "v2"),
            entryOf("did:plc:keep", "k1"),
        ])
        const { delivered, page } = await readSummaryPage(base, current, pageWorld(current.records).deps, 10)
        expect(delivered).toEqual(current)
        expect(page.removed).toEqual([refOf("did:plc:gone")])
        expect(page.records.map((r) => r.did)).toEqual(["did:plc:added", "did:plc:change"])
    })

    it("a delivered record's entry is taken from its own CAR read, so bytes match the index", async () => {
        const indexed = entryOf("did:plc:a", "cid-indexed")
        const w = pageWorld([indexed], { recordFor: (e) => ({ ...e, cid: "cid-now", verifiedWith: "zKey" }) })
        const { page, delivered } = await readSummaryPage(null, indexOf([indexed]), w.deps, 10)
        expect(page.records[0]).toMatchObject({ cid: "cid-now" })
        expect(carText(page.records[0]!)).toBe("car:cid-now")
        expect(delivered.records[0]).toMatchObject({ cid: "cid-now" })
    })

    it("a record gone or no longer servable at its CAR read is reported removed", async () => {
        const base = indexOf([entryOf("did:plc:old", "o1"), entryOf("did:plc:rotated", "r0")])
        const current = indexOf([
            entryOf("did:plc:gone", "g1"),
            entryOf("did:plc:rotated", "r1"),
            entryOf("did:plc:unknown", "u1"),
            entryOf("did:plc:ok", "k1"),
        ])
        const w = pageWorld(current.records, {
            gone: new Set(["did:plc:gone/self"]),
            keys: (did) =>
                did === "did:plc:rotated"
                    ? { kind: "trusted", key: "zNew" }
                    : did === "did:plc:unknown"
                      ? undefined
                      : { kind: "trusted", key: "zKey" },
        })
        const { page, delivered } = await readSummaryPage(base, current, w.deps, 10)
        expect(page.records.map((r) => r.did)).toEqual(["did:plc:ok"])
        // Only what the client held is reported: gone and unknown were never delivered.
        expect(page.removed.map((r) => r.did).sort()).toEqual(["did:plc:old", "did:plc:rotated"])
        expect(delivered.records.map((r) => r.did)).toEqual(["did:plc:ok"])
    })

    it("a record dropped at its CAR read that the client never held is not reported removed", async () => {
        const current = indexOf([entryOf("did:plc:gone", "g1"), entryOf("did:plc:ok", "k1")])
        const w = pageWorld(current.records, { gone: new Set(["did:plc:gone/self"]) })
        const { page } = await readSummaryPage(null, current, w.deps, 10)
        expect(page).toMatchObject({ full: true, removed: [] })
        expect(page.records.map((r) => r.did)).toEqual(["did:plc:ok"])
    })

    it("a snapshot held without an ingest verdict is dropped even where the key is unchecked", async () => {
        const current = indexOf([entryOf("did:web:a", "c1")])
        const w = pageWorld(current.records, { keys: () => ({ kind: "unchecked" }) })
        const inner = w.deps.records
        const records: SummaryPageDeps["records"] = {
            get: async (did, collection, rkey) => {
                const s = await inner.get(did, collection, rkey)
                return s && { ...s, verifiedWith: null }
            },
        }
        const { page, delivered } = await readSummaryPage(null, current, { ...w.deps, records }, 10)
        expect(page.records).toEqual([])
        expect(delivered.records).toEqual([])
    })

    it("paging from each delivered index converges to current with more unset", async () => {
        const current = indexOf(
            Array.from({ length: 7 }, (_, i) => entryOf(`did:plc:d${i}`, `c${i}`))
        )
        const w = pageWorld(current.records)
        let held: SummaryIndex | null = null
        let pages = 0
        let more = true
        while (more) {
            const r = await readSummaryPage(held, current, w.deps, 3)
            held = r.delivered
            more = r.page.more
            pages += 1
            expect(pages).toBeLessThan(10)
        }
        expect(pages).toBe(3)
        expect(held).toEqual(current)
        expect(w.reads).toHaveLength(7)
    })
})

describe("summary delta codec", () => {
    const delta: SummaryDelta = {
        token: "tok",
        full: false,
        ownBlocks: null,
        records: [],
        removed: [],
        verdicts: [],
        droppedVerdicts: [],
        more: true,
        truncated: true,
        coveredThroughMs: null,
        lagging: [],
    }

    it("more and truncated round-trip", () => {
        expect(decodeSummaryDelta(encodeSummaryDelta(delta))).toEqual(delta)
        const off = { ...delta, more: false, truncated: false }
        expect(decodeSummaryDelta(encodeSummaryDelta(off))).toEqual(off)
    })

    it("a body without more or truncated decodes them as false", () => {
        const bytes = encodeCose(
            new Map<string, CoseValue>([
                [SUMMARY_DELTA_KEYS.token, "t"],
                [SUMMARY_DELTA_KEYS.full, false],
                [SUMMARY_DELTA_KEYS.records, []],
                [SUMMARY_DELTA_KEYS.removed, []],
            ])
        )
        expect(decodeSummaryDelta(bytes)).toMatchObject({ more: false, truncated: false })
    })
})

const DECL = DECLARATION_COLLECTION_NSID

/** Evidence for `did`'s declaration at `cid`, bound to commit `bafCommit` at rev `3k`. */
const evidenceFor = (did: string, cid: string, over: Partial<SnapshotEvidence> = {}): SnapshotEvidence => ({
    did,
    collection: DECL,
    rkey: "self",
    recordCid: cid,
    commitCid: "bafCommit",
    rev: "3k",
    verifiedWith: "zKey",
    authority: { method: "plc", operationCid: "bafOp" },
    assurance: "custody-chain",
    monitor: "monitor.example.org",
    commitFirstObservedAtMs: NOW - 5_000,
    anchorFirstObservedAtMs: NOW - 60_000,
    ...over,
})

/** The owner's declaration held at `c1`, with `evidence` stored beside it. */
function declarationWorld(evidence: SnapshotEvidence | null, over: Partial<SummaryHeldEntry> = {}) {
    const raw = held(OWNER, DECL, "self", { cid: "c1", commitCid: "bafCommit", rev: "3k", evidenceState: evidence, ...over })
    const index = indexWorld({ watched: [{ collection: DECL, rkey: "self" }], held: (did) => (did === OWNER ? raw : null) })
    const page = pageWorld([raw])
    return { index, page: { ...page, deps: { ...page.deps, nowMs: () => NOW } } }
}

describe("summary evidence binding", () => {
    it("evidence bound to the stored cid, commit and rev is delivered once, then settles", async () => {
        const w = declarationWorld(evidenceFor(OWNER, "c1"))
        const built = (await buildSummaryIndex(OWNER, w.index.deps))!
        const first = await readSummaryPage(null, built.index, w.page.deps, 10)
        expect(first.page.records[0]!.evidence).toEqual({
            commitCid: "bafCommit",
            rev: "3k",
            authority: { method: "plc", operationCid: "bafOp" },
            assurance: "custody-chain",
            monitor: "monitor.example.org",
            commitAgeMs: 5_000,
            anchorAgeMs: 60_000,
            remainingTtlMs: SNAPSHOT_MAX_AGE_MS,
        })
        const rebuilt = (await buildSummaryIndex(OWNER, w.index.deps))!
        expect(diffSummaryIndex(first.delivered, rebuilt.index).changed).toEqual([])
        expect((await readSummaryPage(first.delivered, rebuilt.index, w.page.deps, 10)).page.records).toEqual([])
    })

    it("stored evidence that fails to bind is delivered as unavailable, then settles", async () => {
        const w = declarationWorld(evidenceFor(OWNER, "c-other"))
        const built = (await buildSummaryIndex(OWNER, w.index.deps))!
        expect(built.index.records[0]!.evidenceState).toBeNull()
        const first = await readSummaryPage(null, built.index, w.page.deps, 10)
        expect(first.page.records.map((r) => r.evidence)).toEqual([null])
        const rebuilt = (await buildSummaryIndex(OWNER, w.index.deps))!
        expect(diffSummaryIndex(first.delivered, rebuilt.index).changed).toEqual([])
        expect((await readSummaryPage(first.delivered, rebuilt.index, w.page.deps, 10)).page.records).toEqual([])
    })

    it("binds against the stored cid, rev and commit without parsing the CAR", async () => {
        // The world's CAR bytes are a placeholder, so a parse would drop the record.
        const w = declarationWorld(evidenceFor(OWNER, "c1"))
        const built = (await buildSummaryIndex(OWNER, w.index.deps))!
        const { page } = await readSummaryPage(null, built.index, w.page.deps, 10)
        expect(page.records).toHaveLength(1)
        expect(page.records[0]!.evidence).toMatchObject({ commitCid: "bafCommit", commitAgeMs: 5_000 })
    })

    it("evidence for another commit than the one stored with the CAR is unavailable", async () => {
        const w = declarationWorld(evidenceFor(OWNER, "c1"), { commitCid: "bafOther" })
        const built = (await buildSummaryIndex(OWNER, w.index.deps))!
        const { page } = await readSummaryPage(null, built.index, w.page.deps, 10)
        expect(page.records).toHaveLength(1)
        expect(page.records[0]!.evidence).toBeNull()
    })
})

describe("wall clock discontinuity", () => {
    it("equal advances of both clocks, or skew under the threshold, never flip it", () => {
        let wall = 1_000_000
        let mono = 0
        const clock = wallClockMonitor({ wallMs: () => wall, monotonicMs: () => mono })
        for (let i = 0; i < 10; i++) {
            expect(clock.observe()).toBe(true)
            wall += 3_600_000
            mono += 3_600_000
        }
        wall += CLOCK_DISCONTINUITY_THRESHOLD_MS
        expect(clock.observe()).toBe(true)
    })

    it("a jump makes ages unavailable and asks for rechecks for the hold window, then clears", async () => {
        let wall = 1_000_000
        let mono = 0
        const wallClock = wallClockMonitor({ wallMs: () => wall, monotonicMs: () => mono })
        const w = declarationWorld(evidenceFor(OWNER, "c1"))
        const rechecks: string[] = []
        w.index.deps.wallClock = wallClock
        w.index.deps.onClockDiscontinuity = (did) => rechecks.push(did)
        const pageDeps = { ...w.page.deps, wallClock }
        const read = async () => {
            const built = (await buildSummaryIndex(OWNER, w.index.deps))!
            return (await readSummaryPage(null, built.index, pageDeps, 10)).page.records[0]!.evidence
        }

        expect(await read()).toMatchObject({ commitAgeMs: 5_000, anchorAgeMs: 60_000 })
        expect(rechecks).toEqual([])

        wall += 60_000
        mono += 1_000
        // The binding stays available; only its ages and TTL are not.
        expect(await read()).toMatchObject({
            commitCid: "bafCommit",
            assurance: "custody-chain",
            commitAgeMs: null,
            anchorAgeMs: null,
            remainingTtlMs: null,
        })
        expect(rechecks).toEqual([OWNER])

        wall += CLOCK_DISCONTINUITY_HOLD_MS
        mono += CLOCK_DISCONTINUITY_HOLD_MS
        expect(await read()).toMatchObject({ commitAgeMs: 5_000, anchorAgeMs: 60_000, remainingTtlMs: SNAPSHOT_MAX_AGE_MS })
        expect(rechecks).toEqual([OWNER])
    })
})

describe("default wall clock detector", () => {
    it("ignores an injected nowMs, so fake times hours apart keep ages available", async () => {
        let now = NOW
        const w = declarationWorld(evidenceFor(OWNER, "c1"))
        const rechecks: string[] = []
        w.index.deps.nowMs = () => now
        w.index.deps.onClockDiscontinuity = (did) => rechecks.push(did)
        const pageDeps = { ...w.page.deps, nowMs: () => now }
        const read = async () => {
            const built = (await buildSummaryIndex(OWNER, w.index.deps))!
            return (await readSummaryPage(null, built.index, pageDeps, 10)).page.records[0]!.evidence
        }

        expect(await read()).toMatchObject({ commitAgeMs: 5_000, anchorAgeMs: 60_000 })
        now = NOW + 3_600_000
        expect(await read()).toMatchObject({ commitAgeMs: 3_605_000, anchorAgeMs: 3_660_000 })
        expect(rechecks).toEqual([])
    })
})
