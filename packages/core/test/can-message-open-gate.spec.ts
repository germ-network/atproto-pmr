/** One rule for an open-only yes, shared by the public route, the owner summary and receive-time admission. */
import { describe, expect, it } from "vitest"
import { admissionOf } from "../src/admission"
import {
    computeCanMessageMany,
    decodeCanMessageVerdict,
    evaluateCanMessage,
    handleCanMessageRead,
    type CanMessageDeps,
    type CanMessageVerdict,
    type DeclaredPolicies,
} from "../src/can-message"
import { buildSummaryIndex } from "../src/summary"
import { DECLARATION_COLLECTION_NSID } from "../src/declaration"
import { owner, OWNER, PEER, read, summaryWorld } from "./fixtures/summary-world"

const GATED: CanMessageVerdict = { verdict: "unknown", pending: ["open"], why: ["policy-not-enabled"] }
const declared = (...policies: string[]): DeclaredPolicies => ({ found: true, policies })
const facts = { blocks: "no", follows: "yes" } as const

describe("open gate", () => {
    it("a yes admitted only by open is held back as unknown[policy-not-enabled] by the shared rule", () => {
        expect(evaluateCanMessage({ declared: declared("open"), blocked: "no", followed: "yes" })).toEqual(GATED)
        expect(evaluateCanMessage({ declared: declared("open"), blocked: "no", followed: "no" })).toEqual(GATED)
        expect(evaluateCanMessage({ declared: declared("bsky-follows"), blocked: "no", followed: "yes" })).toEqual({
            verdict: "yes",
            via: ["bsky-follows"],
        })
        // A block still vetoes, and an unknown block still reads block-unknown.
        expect(evaluateCanMessage({ declared: declared("open"), blocked: "yes", followed: "yes" })).toEqual({
            verdict: "no",
            why: ["blocked"],
        })
        expect(evaluateCanMessage({ declared: declared("open"), blocked: "unknown", followed: "yes" })).toMatchObject({
            verdict: "unknown",
            why: ["block-unknown"],
        })
    })

    it("the public route, the summary and receive-time admission give the same verdict for the same facts", async () => {
        const policies = declared("open")
        const deps: CanMessageDeps = {
            policies: { policiesOf: async () => policies },
            graph: { forSender: async (_s, recipients) => new Map(recipients.map((r) => [r, facts])) },
        }
        const route = await handleCanMessageRead(
            new Request(`https://relay.test/pmr/v1/can-message/${OWNER}/${PEER}`),
            deps
        )
        const viaRoute = decodeCanMessageVerdict(new Uint8Array(await route.arrayBuffer()))

        const w = summaryWorld({ watched: [{ collection: DECLARATION_COLLECTION_NSID, rkey: "self" }] })
        w.declared.set(PEER, { found: true, policies: ["open"] })
        w.senderFacts.set(`${OWNER}|${PEER}`, facts)
        const viaSummary = (await buildSummaryIndex(OWNER, w.deps))!.index.verdicts.find((v) => v.did === PEER)!.verdict
        const wire = (await read(await (await owner(w, OWNER))())).verdicts.find((v) => v.did === PEER)!.verdict

        const many = (await computeCanMessageMany(OWNER, [PEER], deps)).get(PEER)!
        expect(viaRoute).toMatchObject(GATED)
        expect(viaRoute.permissionRecencyAtMs).toBeNull()
        expect(viaSummary).toEqual(GATED)
        expect(wire).toEqual(GATED)
        expect(admissionOf(many)).toEqual({ verdict: "unknown", why: ["policy-not-enabled"] })
    })
})
