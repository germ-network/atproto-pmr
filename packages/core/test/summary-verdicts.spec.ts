/** The owner's summary carries an owner -> contact can-message verdict for each covered contact. */
import { describe, expect, it } from "vitest"
import { canMessageToCose } from "../src/can-message"
import { decodeCoseMap } from "../src/cose/cbor"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import {
    buildSummaryIndex,
    decodeSummaryDelta,
    encodeSummaryDelta,
    readSummaryPage,
    SUMMARY_DELTA_KEYS,
    type SummaryHeldEntry,
    type SummaryIndex,
} from "../src/summary"
import {
    COLLECTION,
    OWNER,
    PEER,
    owner,
    read,
    summaryWorld,
} from "./fixtures/summary-world"
import { indexPolicySource } from "../src/summary-verdicts"

const DECL = "com.germnetwork.declaration"
const held = (did: string, over: Partial<SummaryHeldEntry> = {}): SummaryHeldEntry => ({
    did,
    collection: DECL,
    rkey: "self",
    cid: `cid-${did}`,
    verifiedWith: "zKey",
    freshAtMs: 1,
    ...over,
})

describe("indexPolicySource", () => {
    it("gives a held declaration's stored policies", async () => {
        const policies = { found: true, policies: ["open"] } as const
        const source = indexPolicySource([held("did:plc:a", { policies })])
        expect(await source.policiesOf("did:plc:a")).toEqual(policies)
    })

    it("reads unavailable for a held declaration stored without policies", async () => {
        const source = indexPolicySource([held("did:plc:a")])
        expect(await source.policiesOf("did:plc:a")).toEqual({ found: false, code: "unavailable" })
    })

    it("answers null for a DID with no declaration entry, so it gets no verdict", async () => {
        const source = indexPolicySource([held("did:plc:a")])
        expect(await source.policiesOf("did:plc:other")).toBeNull()
        expect(await indexPolicySource([]).policiesOf("did:plc:a")).toBeNull()
    })

    it("answers null for a contact with only a non-declaration entry", async () => {
        const source = indexPolicySource([
            held("did:plc:a", { collection: "app.example.profile", policies: { found: true, policies: ["open"] } }),
            held("did:plc:b", { rkey: "other" }),
        ])
        expect(await source.policiesOf("did:plc:a")).toBeNull()
        expect(await source.policiesOf("did:plc:b")).toBeNull()
    })

    it("passes undecodable stored policies through", async () => {
        const policies = { found: false, code: "undecodable" } as const
        const source = indexPolicySource([held("did:plc:a", { policies })])
        expect(await source.policiesOf("did:plc:a")).toEqual(policies)
    })
})

const DECL_REF = { collection: DECLARATION_COLLECTION_NSID, rkey: "self" }
const THIRD = "did:plc:third000000000000000000"
const open = { found: true, policies: ["open"] } as const
const clear = { blocks: "no", follows: "no" } as const

/** A world that watches declarations, where the owner follows PEER, who declares `open`. */
function world(extra: { collection: string; rkey: string }[] = []) {
    const w = summaryWorld({ watched: [DECL_REF, ...extra] })
    w.declared.set(PEER, open)
    w.senderFacts.set(`${OWNER}|${PEER}`, clear)
    return w
}
const verdictOf = (d: { verdicts: { did: string; verdict: unknown }[] }, did: string) =>
    d.verdicts.find((v) => v.did === did)?.verdict

describe("summary verdicts", () => {
    it("a full summary carries a verdict for every covered contact with a held declaration, and none for the owner", async () => {
        const w = world()
        w.declared.set(OWNER, open)
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        w.versions.set(THIRD, 1)
        w.declared.set(THIRD, open)
        w.senderFacts.set(`${OWNER}|${THIRD}`, clear)
        const delta = await read(await (await owner(w, OWNER))())
        expect(delta.verdicts.map((v) => v.did)).toEqual([PEER, THIRD].sort())
        expect(verdictOf(delta, PEER)).toEqual({ verdict: "yes", via: ["open"] })
    })

    it("an unchanged verdict is absent from the delta", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const second = await read(await get(first.token))
        expect(second.verdicts).toEqual([])
        expect(second.droppedVerdicts).toEqual([])
    })

    it("a changed verdict is present, compared by its encoded bytes", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        w.senderFacts.set(`${OWNER}|${PEER}`, { blocks: "yes", follows: "no" })
        const second = await read(await get(first.token))
        expect(second.verdicts).toEqual([{ did: PEER, verdict: { verdict: "no", why: ["blocked"] } }])

        const held: SummaryIndex = { owner: OWNER, ownBlocks: [], records: [], verdicts: [{ did: PEER, verdict: { verdict: "yes", via: ["open"] } }] }
        // Same verdict, fields in another order: equal on the wire.
        const same = { ...held, verdicts: [{ did: PEER, verdict: { via: ["open"], verdict: "yes" } as const }] }
        const { page } = await readSummaryPage(held, same, w.deps, 10)
        expect(page.verdicts).toEqual([])
        const other = { ...held, verdicts: [{ did: PEER, verdict: { verdict: "yes", via: ["open", "bsky-follows"] } }] }
        expect((await readSummaryPage(held, other, w.deps, 10)).page.verdicts).toHaveLength(1)
    })

    it("a contact no longer covered, or whose verdict disappeared, is listed in y", async () => {
        const w = world()
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        w.versions.set(THIRD, 1)
        w.declared.set(THIRD, open)
        w.senderFacts.set(`${OWNER}|${THIRD}`, clear)
        const get = await owner(w, OWNER)
        const first = await read(await get())
        expect(first.verdicts).toHaveLength(2)
        w.ownGraphs.get(OWNER)!.followers.length = 0
        const second = await read(await get(first.token))
        expect(second.droppedVerdicts).toEqual([THIRD])
        w.versions.delete(PEER)
        const third = await read(await get(second.token))
        expect(third.droppedVerdicts).toEqual([PEER])
        expect(third.verdicts).toEqual([])
    })

    // The sender-graph fake answers only for sender === owner, so a swapped direction fails.
    it("asks forSender for (owner, the contacts with a servable declaration), excluding the owner", async () => {
        const w = world()
        w.declared.set(OWNER, open)
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        await buildSummaryIndex(OWNER, w.deps)
        expect(w.senderAsked).toEqual([{ sender: OWNER, recipients: [PEER] }])
    })

    it("verdicts are sorted by DID", async () => {
        const w = world()
        const first = "did:plc:aaa000000000000000000000"
        w.ownGraphs.get(OWNER)!.followers.push({ did: first, mutual: false })
        w.versions.set(first, 1)
        w.declared.set(first, open)
        w.senderFacts.set(`${OWNER}|${first}`, clear)
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(built!.index.verdicts.map((v) => v.did)).toEqual([first, PEER])
    })

    it("a held declaration that is not servable under rotation gets no verdict, and leaves it listed in y", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        expect(first.verdicts).toHaveLength(1)
        const keysFor = w.deps.signingKeys.keysFor
        w.deps.signingKeys.keysFor = async (dids) => {
            const keys = await keysFor(dids)
            keys.set(PEER, { kind: "unknown" })
            return keys
        }
        const second = await read(await get(first.token))
        expect(second.verdicts).toEqual([])
        expect(second.droppedVerdicts).toEqual([PEER])
        expect(w.senderAsked).toHaveLength(1)
    })

    it("a verdict left out of an index whose records never reached the client is still listed in y, and the token changes", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const store = w.deps.store(`loc:${OWNER}`)
        const held = (await store.getSummaryIndex(first.token))!
        await store.putSummaryIndex(
            "tok",
            { ...held, verdicts: [...held.verdicts, { did: THIRD, verdict: { verdict: "yes", via: ["open"] } }] },
            0
        )
        const next = await read(await get("tok"))
        expect(next.removed).toEqual([])
        expect(next.records).toEqual([])
        expect(next.droppedVerdicts).toEqual([THIRD])
        expect(next.token).not.toBe("tok")
    })

    it("a contact blocking the owner yields no{why:[blocked]}", async () => {
        const w = world()
        w.senderFacts.set(`${OWNER}|${PEER}`, { blocks: "yes", follows: "no" })
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(built!.index.verdicts).toEqual([{ did: PEER, verdict: { verdict: "no", why: ["blocked"] } }])
    })

    it("index records carry no policies field", async () => {
        const w = world()
        w.declared.set(OWNER, open)
        const built = await buildSummaryIndex(OWNER, w.deps)
        expect(built!.index.records.length).toBeGreaterThan(0)
        for (const record of built!.index.records) expect(record).not.toHaveProperty("policies")
    })

    it("verdicts change independently of the owner's blocks (b) and the records (r)", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        w.senderFacts.set(`${OWNER}|${PEER}`, { blocks: "yes", follows: "no" })
        const verdictOnly = await read(await get(first.token))
        expect(verdictOnly).toMatchObject({ ownBlocks: null, records: [], removed: [] })
        expect(verdictOnly.verdicts).toHaveLength(1)

        w.blocks.set(OWNER, [{ blocker: OWNER, rkey: "b1", subject: "did:plc:x" }])
        const blocksOnly = await read(await get(verdictOnly.token))
        expect(blocksOnly.ownBlocks).not.toBeNull()
        expect(blocksOnly).toMatchObject({ records: [], verdicts: [], droppedVerdicts: [] })

        w.versions.set(PEER, 2)
        const recordOnly = await read(await get(blocksOnly.token))
        expect(recordOnly.records).toHaveLength(1)
        expect(recordOnly).toMatchObject({ ownBlocks: null, verdicts: [], droppedVerdicts: [] })
    })

    it("a delta with only verdict changes is not reported unchanged and gets a new token", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const same = await read(await get(first.token))
        expect(same.token).toBe(first.token)
        w.senderFacts.set(`${OWNER}|${PEER}`, { blocks: "yes", follows: "no" })
        const changed = await read(await get(first.token))
        expect(changed.token).not.toBe(first.token)
        const dropped = world()
        const get2 = await owner(dropped, OWNER)
        const base = await read(await get2())
        dropped.declared.delete(PEER)
        dropped.versions.delete(PEER)
        dropped.ownGraphs.get(OWNER)!.following.length = 0
        const gone = await read(await get2(base.token))
        expect(gone.token).not.toBe(base.token)
    })

    it("answers 503 + Retry-After and leaves the baseline untouched when the sender-graph read throws", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        const first = await read(await get())
        const puts = w.puts.length
        w.senderFail.add(OWNER)
        const res = await get(first.token)
        expect(res.status).toBe(503)
        expect(res.headers.get("Retry-After")).not.toBeNull()
        expect(w.puts).toHaveLength(puts)
        w.senderFail.delete(OWNER)
        expect((await get(first.token)).status).toBe(200)
    })

    it("reads the contacts' graph facts at most once per build, and not at all when no declaration is held", async () => {
        const w = world()
        await buildSummaryIndex(OWNER, w.deps)
        expect(w.senderAsked).toHaveLength(1)
        const none = world()
        none.declared.clear()
        none.versions.delete(PEER)
        none.versions.delete(OWNER)
        await buildSummaryIndex(OWNER, none.deps)
        expect(none.senderAsked).toHaveLength(0)
    })

    it("with records over pageRecords, page 1 carries every changed verdict and the next page none", async () => {
        const w = world([{ collection: COLLECTION, rkey: "self" }])
        w.ownGraphs.get(OWNER)!.followers.push({ did: THIRD, mutual: false })
        w.versions.set(THIRD, 1)
        w.declared.set(THIRD, open)
        w.senderFacts.set(`${OWNER}|${THIRD}`, clear)
        w.deps.pageRecords = 1
        const get = await owner(w, OWNER)
        const page1 = await read(await get())
        expect(page1.more).toBe(true)
        expect(page1.verdicts).toHaveLength(2)
        const page2 = await read(await get(page1.token))
        expect(page2.records.length).toBeGreaterThan(0)
        expect(page2.verdicts).toEqual([])
        expect(page2.droppedVerdicts).toEqual([])
    })

    it("a full response carries every verdict and an empty y", async () => {
        const w = world()
        const get = await owner(w, OWNER)
        await read(await get())
        const full = await read(await get("unknown-token"))
        expect(full.full).toBe(true)
        expect(full.verdicts).toHaveLength(1)
        expect(full.droppedVerdicts).toEqual([])
    })

    it("a baseline stored without verdicts reads as [] and resends every verdict", async () => {
        const w = world()
        const current = (await buildSummaryIndex(OWNER, w.deps))!.index
        const legacy = { ...current, verdicts: undefined } as unknown as SummaryIndex
        const { page } = await readSummaryPage(legacy, current, w.deps, 10)
        expect(page.full).toBe(false)
        expect(page.verdicts).toEqual(current.verdicts)
        expect(page.droppedVerdicts).toEqual([])
    })

    it("encodes c as a list of {d, v} with v the canMessageToCose map, and y as a list of DIDs", () => {
        const verdict = { verdict: "yes", via: ["open"] } as const
        const delta = {
            token: "t",
            full: false,
            ownBlocks: null,
            records: [],
            removed: [],
            verdicts: [{ did: PEER, verdict }],
            droppedVerdicts: [THIRD],
            more: false,
            truncated: false,
        }
        const wire = decodeCoseMap(encodeSummaryDelta(delta))
        expect(SUMMARY_DELTA_KEYS.verdicts).toBe("c")
        expect(SUMMARY_DELTA_KEYS.droppedVerdicts).toBe("y")
        expect(wire.get("c")).toEqual([new Map([["d", PEER], ["v", canMessageToCose(verdict)]])])
        expect(wire.get("y")).toEqual([THIRD])
        expect(decodeSummaryDelta(encodeSummaryDelta(delta))).toEqual(delta)
    })
})
