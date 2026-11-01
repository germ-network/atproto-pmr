/** The owner's summary marks each contact's verdict entry with whether the contact is a mutual follow. */
import { describe, expect, it } from "vitest"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import {
    buildSummaryIndex,
    decodeSummaryDelta,
    encodeSummaryDelta,
    summaryContacts,
    type SummaryDelta,
    type SummaryIndex,
} from "../src/summary"
import { OWNER, PEER, owner, read, summaryWorld } from "./fixtures/summary-world"

const THIRD = "did:plc:third000000000000000000"
const follows = { found: true, policies: ["bsky-follows"] } as const
const clear = { blocks: "no", follows: "yes" } as const

/** A world where the owner follows PEER, who declares `bsky-follows`. */
function world() {
    const w = summaryWorld({ watched: [{ collection: DECLARATION_COLLECTION_NSID, rkey: "self" }] })
    w.declared.set(PEER, follows)
    w.senderFacts.set(`${OWNER}|${PEER}`, clear)
    return w
}

/** Marks `did` as followed by the owner and following back, on both edge lists. */
function setMutual(w: ReturnType<typeof world>, did: string, mutual: boolean) {
    const graph = w.ownGraphs.get(OWNER)!
    for (const list of [graph.following, graph.followers]) {
        const edge = list.find((e) => e.did === did)
        if (edge) edge.mutual = mutual
        else list.push({ did, mutual })
    }
}

const mutualOf = (d: { verdicts: { did: string; mutual: boolean }[] }, did: string) =>
    d.verdicts.find((v) => v.did === did)?.mutual

describe("summary mutual bit", () => {
    it("sets mutual on a contact the owner follows and who follows the owner, and only on those", async () => {
        const w = world()
        w.versions.set(THIRD, 1)
        w.declared.set(THIRD, follows)
        w.senderFacts.set(`${OWNER}|${THIRD}`, clear)
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        setMutual(w, PEER, true)
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(mutualOf(built!.index, PEER)).toBe(true)
        expect(mutualOf(built!.index, THIRD)).toBe(false)
        expect(built!.index.verdicts.some((v) => v.did === OWNER)).toBe(false)
    })

    it("reads a mutual edge from either list, so the bit and the mutuals-first tier agree", async () => {
        const w = world()
        w.versions.set(THIRD, 1)
        w.declared.set(THIRD, follows)
        w.senderFacts.set(`${OWNER}|${THIRD}`, clear)
        const graph = w.ownGraphs.get(OWNER)!
        graph.followers.push({ did: THIRD, mutual: true })
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(mutualOf(built!.index, THIRD)).toBe(true)
        expect(mutualOf(built!.index, PEER)).toBe(false)
        // PEER sorts before THIRD, so THIRD leads only from the mutual tier.
        expect(summaryContacts(OWNER, graph, 100).dids).toEqual([OWNER, THIRD, PEER])
    })

    it("takes mutual from the graph the relay already reads for ordering, with no further read", async () => {
        const w = world()
        setMutual(w, PEER, true)
        let reads = 0
        const ownGraph = w.deps.graph.ownGraph
        w.deps.graph.ownGraph = async (did) => {
            reads += 1
            return ownGraph(did)
        }
        await buildSummaryIndex(OWNER, w.deps)
        expect(reads).toBe(1)
        expect(w.senderAsked).toHaveLength(1)
    })

    it("a change to a contact's mutual bit alone re-sends its entry and gets a new token", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        expect(mutualOf(first, PEER)).toBe(false)
        setMutual(w, PEER, true)
        const second = await read(await get(first.token))
        expect(second.token).not.toBe(first.token)
        expect(second.verdicts).toEqual([{ did: PEER, verdict: first.verdicts[0]!.verdict, mutual: true, permissionRecencyAtMs: null }])
        expect(second).toMatchObject({ ownBlocks: null, records: [], removed: [], droppedVerdicts: [] })
    })

    it("an unchanged verdict and mutual bit is not re-sent, and the named token comes back", async () => {
        const w = world()
        setMutual(w, PEER, true)
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const second = await read(await get(first.token))
        expect(second.verdicts).toEqual([])
        expect(second.token).toBe(first.token)
    })

    it("a baseline stored before mutual bits re-sends every verdict entry once", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const store = w.deps.store(`loc:${OWNER}`)
        const held = (await store.getSummaryIndex(first.token))!
        const legacy = {
            ...held,
            verdicts: held.verdicts.map(({ did, verdict }) => ({ did, verdict })),
        } as unknown as SummaryIndex
        await store.putSummaryIndex("legacy", legacy, 0)
        const resent = await read(await get("legacy"))
        expect(resent.full).toBe(false)
        expect(resent.verdicts).toEqual(held.verdicts)
        expect(resent.token).not.toBe("legacy")
        const settled = await read(await get(resent.token))
        expect(settled.verdicts).toEqual([])
        expect(settled.token).toBe(resent.token)
    })

    it("a mutual flip between pages of a paged read arrives on the next read", async () => {
        const w = world()
        w.deps.pageRecords = 1
        w.versions.set(THIRD, 1)
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        const get = await owner(w, OWNER)
        const page1 = await read(await get())
        expect(page1.more).toBe(true)
        setMutual(w, PEER, true)
        const page2 = await read(await get(page1.token))
        expect(mutualOf(page2, PEER)).toBe(true)
    })

    it("a full response carries mutual on every verdict entry", async () => {
        const w = world()
        setMutual(w, PEER, true)
        const get = await owner(w, OWNER)
        await read(await get())
        const full = await read(await get("unknown-token"))
        expect(full.full).toBe(true)
        expect(full.verdicts).toHaveLength(1)
        expect(mutualOf(full, PEER)).toBe(true)
    })

    it("encodes u on every c entry as a CBOR boolean, false included", () => {
        const delta = { ...VECTOR_DELTA }
        const wire = decodeCoseMap(encodeSummaryDelta(delta))
        const entries = wire.get("c") as Map<string, unknown>[]
        expect(entries.map((e) => e.get("u"))).toEqual([true, false])
    })

    it("decodes an entry with no u, from a relay that predates it, as not mutual", () => {
        expect(decodeAfterEdit((c) => c[0]!.delete("u")).verdicts.map((v) => v.mutual)).toEqual([false, false])
    })

    it("rejects an entry whose u is not a boolean", () => {
        expect(() => decodeAfterEdit((c) => c[0]!.set("u", 1))).toThrow("summary: malformed mutual")
        expect(() => decodeAfterEdit((c) => c[1]!.set("u", "true"))).toThrow("summary: malformed mutual")
    })

    it("matches the published summary test vector byte for byte, both ways", () => {
        expect(hex(encodeSummaryDelta(VECTOR_DELTA))).toBe(VECTOR_HEX)
        expect(decodeSummaryDelta(fromHex(VECTOR_HEX))).toEqual(VECTOR_DELTA)
    })
})

/** The delta of the test vector in wire-api.md, Summary test vector. */
const VECTOR_DELTA: SummaryDelta = {
    token: "abc",
    full: false,
    ownBlocks: null,
    records: [],
    removed: [],
    verdicts: [
        { did: "did:plc:a", verdict: { verdict: "yes", via: ["bsky-follows"] }, mutual: true },
        { did: "did:plc:b", verdict: { verdict: "no", why: ["not-admitted"] }, mutual: false },
    ],
    droppedVerdicts: [],
    more: false,
    truncated: false,
    coveredThroughMs: 1_700_000_000_000,
    lagging: ["did:plc:b"],
}

/** Hand-assembled from the spec's diagnostic notation under RFC 8949 §4.2.1, not from the encoder. */
const VECTOR_HEX = [
    "ab",
    "6162f6",
    "616382",
    "a3" + "616469" + "6469643a706c633a61" + "6175f5",
    "6176a2" + "616181" + "6c" + "62736b792d666f6c6c6f7773" + "617663" + "796573",
    "a3" + "616469" + "6469643a706c633a62" + "6175f4",
    "6176a2" + "617281" + "6c" + "6e6f742d61646d6974746564" + "617662" + "6e6f",
    "6166f4",
    "616c81" + "69" + "6469643a706c633a62",
    "616df4",
    "616ef4",
    "617280",
    "617463616263",
    "6177" + "1b" + "0000018bcfe56800",
    "617880",
    "617980",
].join("")

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

/** Decodes the vector after editing its `c` entries as wire maps. */
function decodeAfterEdit(edit: (c: Map<string, unknown>[]) => void): SummaryDelta {
    const wire = decodeCoseMap(fromHex(VECTOR_HEX))
    edit(wire.get("c") as Map<string, unknown>[])
    return decodeSummaryDelta(encodeCose(wire as CoseValue))
}
