/** The owner's summary carries an owner -> contact can-message verdict for each covered contact. */
import { describe, expect, it } from "vitest"
import type { SummaryHeldEntry } from "../src/summary"
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

describe("summary verdicts", () => {
    it.todo("a full summary carries a verdict for every covered contact with a held declaration, and none for the owner")
    it.todo("an unchanged verdict is absent from the delta")
    it.todo("a changed verdict is present, compared by its encoded bytes")
    it.todo("a contact no longer covered, or whose verdict disappeared, is listed in y")
    // The sender-graph fake answers only for sender === owner, so a swapped direction fails.
    it.todo("asks forSender for (owner, the contacts with a servable declaration), excluding the owner")
    it.todo("a contact blocking the owner yields no{why:[blocked]}")
    it.todo("index records carry no policies field")
    it.todo("verdicts change independently of the owner's blocks (b) and the records (r)")
    it.todo("a delta with only verdict changes is not reported unchanged and gets a new token")
    it.todo("answers 503 + Retry-After and leaves the baseline untouched when the sender-graph read throws")
    it.todo("reads the contacts' graph facts at most once per build, and not at all when no declaration is held")
    it.todo("with records over pageRecords, page 1 carries every changed verdict and the next page none")
    it.todo("a full response carries every verdict and an empty y")
    it.todo("a baseline stored without verdicts reads as [] and resends every verdict")
    it.todo("encodes c as a list of {d, v} with v the canMessageToCose map, and y as a list of DIDs")
})
