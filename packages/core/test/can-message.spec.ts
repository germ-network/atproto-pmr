/**
 * The "can A message B?" verdict: yes names every admitting policy, a
 * Bluesky block vetoes every policy, and missing data reads as unknown,
 * never as no.
 */
import { describe, expect, it, vi } from "vitest"
import {
    CAN_MESSAGE_KEYS,
    canMessageFromCose,
    canMessageToCose,
    computeCanMessage,
    computeCanMessageMany,
    declaredPoliciesOf,
    decodeCanMessageVerdict,
    encodeCanMessageVerdict,
    evaluateCanMessage,
    handleCanMessageRead,
    snapshotPolicySource,
    type CanMessageDeps,
    type CanMessageFacts,
    type CanMessageVerdict,
    type PairFact,
    type RecipientGraphFacts,
    type SenderGraphReader,
} from "../src/can-message"
import { decodeCoseMap, encodeCose } from "../src/cose/cbor"
import { SNAPSHOT_MAX_AGE_MS, type StoredRecordSnapshot } from "../src/snapshot-read"
import type { AllowPolicy, DeclaredPolicies, StoredPolicies } from "../src/policy"

export type Case = { facts: CanMessageFacts; expected: CanMessageVerdict }

const found = (...policies: AllowPolicy[]): DeclaredPolicies => ({ found: true, policies })
const evalWith = (
    declared: DeclaredPolicies,
    blocked: PairFact = "no",
    followed: PairFact = "no"
): CanMessageVerdict => evaluateCanMessage({ declared, blocked, followed })

describe("evaluateCanMessage", () => {
    it("no declaration is no [no-declaration]", () => {
        expect(evalWith({ found: false, code: "no-declaration" })).toEqual({
            verdict: "no",
            why: ["no-declaration"],
        })
    })

    it("an unavailable declaration snapshot is unknown [declaration-unavailable] with nothing pending", () => {
        expect(evalWith({ found: false, code: "unavailable" })).toEqual({
            verdict: "unknown",
            pending: [],
            why: ["declaration-unavailable"],
        })
    })

    it("an undecodable policy is unknown [policy-undecodable] with nothing pending", () => {
        expect(evalWith({ found: false, code: "undecodable" })).toEqual({
            verdict: "unknown",
            pending: [],
            why: ["policy-undecodable"],
        })
    })

    it("a declaration with no policies (closed) is no [not-admitted]", () => {
        expect(evalWith(found())).toEqual({ verdict: "no", why: ["not-admitted"] })
    })

    it("open admits: yes via [open]", () => {
        expect(evalWith(found("open"))).toEqual({ verdict: "yes", via: ["open"] })
    })

    it("bsky-follows admits when B follows A: yes via [bsky-follows]", () => {
        expect(evalWith(found("bsky-follows"), "no", "yes")).toEqual({
            verdict: "yes",
            via: ["bsky-follows"],
        })
    })

    it("bsky-follows refuses when B is known not to follow A: no [not-admitted]", () => {
        expect(evalWith(found("bsky-follows"), "no", "no")).toEqual({
            verdict: "no",
            why: ["not-admitted"],
        })
    })

    it("bsky-follows with an unknown follow is unknown pending [bsky-follows] [graph-incomplete]", () => {
        expect(evalWith(found("bsky-follows"), "no", "unknown")).toEqual({
            verdict: "unknown",
            pending: ["bsky-follows"],
            why: ["graph-incomplete"],
        })
    })

    it("yes lists every admitting policy, in declared order", () => {
        expect(evalWith(found("bsky-follows", "open"), "no", "yes")).toEqual({
            verdict: "yes",
            via: ["bsky-follows", "open"],
        })
        expect(evalWith(found("open", "bsky-follows"), "no", "yes")).toEqual({
            verdict: "yes",
            via: ["open", "bsky-follows"],
        })
    })

    it("one admitting policy wins over another pending one: yes, not unknown", () => {
        expect(evalWith(found("open", "bsky-follows", "future"), "no", "unknown")).toEqual({
            verdict: "yes",
            via: ["open"],
        })
    })

    it("an unrecognized policy is pending [policy-unrecognized], never admitting or refusing", () => {
        expect(evalWith(found("future"))).toEqual({
            verdict: "unknown",
            pending: ["future"],
            why: ["policy-unrecognized"],
        })
        expect(evalWith(found("a", "b", "bsky-follows"), "no", "unknown")).toEqual({
            verdict: "unknown",
            pending: ["a", "b", "bsky-follows"],
            why: ["policy-unrecognized", "graph-incomplete"],
        })
    })

    it("B blocks A is no [blocked] even under open", () => {
        expect(evalWith(found("open"), "yes", "yes")).toEqual({ verdict: "no", why: ["blocked"] })
    })

    it("an unknown block turns would-be yes into unknown pending the admitting policies, [block-unknown] first", () => {
        expect(evalWith(found("open", "future"), "unknown")).toEqual({
            verdict: "unknown",
            pending: ["open", "future"],
            why: ["block-unknown", "policy-unrecognized"],
        })
    })

    it("an unknown block with nothing admitting or pending stays no [not-admitted]", () => {
        expect(evalWith(found(), "unknown")).toEqual({ verdict: "no", why: ["not-admitted"] })
        expect(evalWith(found("bsky-follows"), "unknown", "no")).toEqual({
            verdict: "no",
            why: ["not-admitted"],
        })
    })
})

const DID_B = "did:plc:bbbb"

function snapshot(over: Partial<StoredRecordSnapshot> = {}): StoredRecordSnapshot {
    return {
        car: new Uint8Array([1]),
        freshAtMs: 1_000,
        verifiedWith: "zKey",
        rev: "r",
        cid: "c",
        ...over,
    }
}

function sourceWith(over: {
    serves?: boolean
    snapshot?: StoredRecordSnapshot | null
    nowMs?: number
    read?: Awaited<ReturnType<Parameters<typeof snapshotPolicySource>[0]["readDeclaration"]>>
}) {
    const recheck = vi.fn()
    const readDeclaration = vi.fn(async () => over.read ?? { found: false as const, reason: "none" })
    const source = snapshotPolicySource({
        serves: async () => over.serves ?? true,
        snapshot: async () => (over.snapshot === undefined ? snapshot() : over.snapshot),
        readDeclaration,
        recheck,
        nowMs: () => over.nowMs ?? 2_000,
    })
    return { source, recheck, readDeclaration }
}

describe("snapshotPolicySource", () => {
    it("a DID this deployment does not serve is null", async () => {
        const { source } = sourceWith({ serves: false })
        expect(await source.policiesOf(DID_B)).toBeNull()
    })

    it("a served DID with no snapshot held is null, exactly as an unserved one", async () => {
        const { source } = sourceWith({ snapshot: null })
        expect(await source.policiesOf(DID_B)).toBeNull()
    })

    it("a held snapshot that does not read (unverifiable, out of date) is unavailable", async () => {
        const { source } = sourceWith({})
        expect(await source.policiesOf(DID_B)).toEqual({ found: false, code: "unavailable" })
    })

    it("a held snapshot with stored policies returns them without reading the CAR", async () => {
        const policies: StoredPolicies = { found: true, policies: ["open"] }
        const { source, readDeclaration } = sourceWith({ snapshot: snapshot({ policies }) })
        expect(await source.policiesOf(DID_B)).toEqual(policies)
        expect(readDeclaration).not.toHaveBeenCalled()
        const undecodable: StoredPolicies = { found: false, code: "undecodable" }
        const again = sourceWith({ snapshot: snapshot({ policies: undecodable }) })
        expect(await again.source.policiesOf(DID_B)).toEqual(undecodable)
    })

    it("a held snapshot without stored policies falls back to declaredPoliciesOf over the verified read", async () => {
        const keyPackage = declarationKeyPackage(2)
        const { source, readDeclaration } = sourceWith({
            read: { found: true, record: { keyPackage }, cid: "c", rev: "r", car: new Uint8Array() },
        })
        expect(await source.policiesOf(DID_B)).toEqual({ found: true, policies: ["open"] })
        expect(readDeclaration).toHaveBeenCalledWith(DID_B)
    })

    it("a snapshot ingest did not verify (verifiedWith null) is unavailable, whatever policies it carries", async () => {
        const { source, readDeclaration } = sourceWith({
            snapshot: snapshot({ verifiedWith: null, policies: { found: true, policies: ["open"] } }),
        })
        expect(await source.policiesOf(DID_B)).toEqual({ found: false, code: "unavailable" })
        expect(readDeclaration).not.toHaveBeenCalled()
    })

    it("a snapshot past SNAPSHOT_MAX_AGE_MS is still answered, and recheck is requested for it", async () => {
        const policies: StoredPolicies = { found: true, policies: ["open"] }
        const stale = sourceWith({
            snapshot: snapshot({ policies }),
            nowMs: 1_000 + SNAPSHOT_MAX_AGE_MS + 1,
        })
        expect(await stale.source.policiesOf(DID_B)).toEqual(policies)
        expect(stale.recheck).toHaveBeenCalledWith(DID_B)
        const fresh = sourceWith({ snapshot: snapshot({ policies }) })
        await fresh.source.policiesOf(DID_B)
        expect(fresh.recheck).not.toHaveBeenCalled()
    })
})

/** A keyPackage with no succession proofs and the given policy byte. */
function declarationKeyPackage(policy: number): Uint8Array {
    const pkg = [0, policy, 1, 1]
    return Uint8Array.from([0, ...new Array(64).fill(5), pkg.length, ...pkg])
}

describe("declaredPoliciesOf", () => {
    it("a record without keyPackage bytes, or whose keyPackage does not parse, is undecodable", () => {
        const undecodable = { found: false, code: "undecodable" }
        expect(declaredPoliciesOf({})).toEqual(undecodable)
        expect(declaredPoliciesOf(null)).toEqual(undecodable)
        expect(declaredPoliciesOf({ keyPackage: "text" })).toEqual(undecodable)
        expect(declaredPoliciesOf({ keyPackage: new Uint8Array([1, 2, 3]) })).toEqual(undecodable)
    })

    it("a parsed AnchorPolicy is mapped through allowPoliciesOf", () => {
        expect(declaredPoliciesOf({ keyPackage: declarationKeyPackage(0) })).toEqual(found())
        expect(declaredPoliciesOf({ keyPackage: declarationKeyPackage(1) })).toEqual(found("bsky-follows"))
        expect(declaredPoliciesOf({ keyPackage: declarationKeyPackage(2) })).toEqual(found("open"))
        expect(declaredPoliciesOf({ keyPackage: declarationKeyPackage(7) })).toEqual(
            found("anchor-policy-7")
        )
    })

    it("messageMe.showButtonTo is never read: it is a UI hint, not the policy", () => {
        for (const showButtonTo of ["none", "everyone", "usersIFollow"]) {
            expect(
                declaredPoliciesOf({ keyPackage: declarationKeyPackage(2), messageMe: { showButtonTo } })
            ).toEqual(found("open"))
        }
    })
})

/** A reader keyed by (sender, recipient) so a swapped direction reads differently. */
function fakeGraph(table: Record<string, RecipientGraphFacts>) {
    const calls: { sender: string; recipients: readonly string[] }[] = []
    const reader: SenderGraphReader = {
        async forSender(sender, recipients) {
            calls.push({ sender, recipients })
            return new Map(
                recipients.map((r) => [
                    r,
                    table[`${sender}>${r}`] ?? { blocks: "unknown", follows: "unknown" },
                ])
            )
        },
    }
    return { reader, calls }
}

const DID_A = "did:plc:aaaa"
const DID_C = "did:plc:cccc"

function depsFor(
    policies: Record<string, DeclaredPolicies>,
    table: Record<string, RecipientGraphFacts> = {}
) {
    const graph = fakeGraph(table)
    const deps: CanMessageDeps = {
        policies: { policiesOf: async (did) => policies[did] ?? null },
        graph: graph.reader,
    }
    return { deps, calls: graph.calls }
}

describe("computeCanMessage", () => {
    it("null when the policy source holds nothing for the recipient, without touching the graph", async () => {
        const { deps, calls } = depsFor({})
        expect(await computeCanMessage(DID_A, DID_B, deps)).toBeNull()
        expect(calls).toEqual([])
    })

    it("passes the recipient-blocks-sender and recipient-follows-sender facts to evaluateCanMessage", async () => {
        const { deps } = depsFor(
            { [DID_A]: found("bsky-follows"), [DID_B]: found("bsky-follows") },
            {
                [`${DID_A}>${DID_B}`]: { blocks: "no", follows: "yes" },
                [`${DID_B}>${DID_A}`]: { blocks: "yes", follows: "no" },
            }
        )
        expect(await computeCanMessage(DID_A, DID_B, deps)).toEqual({
            verdict: "yes",
            via: ["bsky-follows"],
        })
        expect(await computeCanMessage(DID_B, DID_A, deps)).toEqual({
            verdict: "no",
            why: ["blocked"],
        })
    })
})

describe("computeCanMessageMany", () => {
    const policies = { [DID_B]: found("open"), [DID_C]: found("bsky-follows") }
    const table = {
        [`${DID_A}>${DID_B}`]: { blocks: "yes", follows: "no" },
        [`${DID_A}>${DID_C}`]: { blocks: "no", follows: "yes" },
    } satisfies Record<string, RecipientGraphFacts>

    it("each recipient's verdict equals computeCanMessage for that pair", async () => {
        const { deps } = depsFor(policies, table)
        const many = await computeCanMessageMany(DID_A, [DID_B, DID_C], deps)
        for (const r of [DID_B, DID_C]) {
            expect(many.get(r)).toEqual(await computeCanMessage(DID_A, r, deps))
        }
    })

    it("one graph read for all recipients the relay holds something for; none when it holds nothing", async () => {
        const { deps, calls } = depsFor(policies, table)
        await computeCanMessageMany(DID_A, [DID_B, DID_C, "did:plc:none", DID_B], deps)
        expect(calls).toEqual([{ sender: DID_A, recipients: [DID_B, DID_C] }])
        const empty = depsFor({})
        await computeCanMessageMany(DID_A, [DID_B], empty.deps)
        expect(empty.calls).toEqual([])
    })

    it("recipients the relay holds nothing for are absent from the map", async () => {
        const { deps } = depsFor(policies, table)
        const many = await computeCanMessageMany(DID_A, [DID_B, "did:plc:none"], deps)
        expect([...many.keys()]).toEqual([DID_B])
    })
})

const VERDICTS: CanMessageVerdict[] = [
    { verdict: "yes", via: ["open", "bsky-follows"] },
    { verdict: "no", why: ["blocked"] },
    { verdict: "unknown", pending: ["bsky-follows"], why: ["block-unknown", "graph-incomplete"] },
    { verdict: "unknown", pending: [], why: ["declaration-unavailable"] },
]

describe("verdict wire form", () => {
    it("each verdict round-trips through encode/decode under CAN_MESSAGE_KEYS", () => {
        for (const v of VERDICTS) {
            expect(decodeCanMessageVerdict(encodeCanMessageVerdict(v))).toEqual(v)
        }
        const map = decodeCoseMap(encodeCanMessageVerdict(VERDICTS[0]!))
        expect(map.get(CAN_MESSAGE_KEYS.verdict)).toBe("yes")
    })

    it("encodeCanMessageVerdict(v) equals encodeCose(canMessageToCose(v)), and canMessageFromCose inverts canMessageToCose", () => {
        for (const v of VERDICTS) {
            expect(encodeCanMessageVerdict(v)).toEqual(encodeCose(canMessageToCose(v)))
            expect(canMessageFromCose(canMessageToCose(v))).toEqual(v)
        }
    })

    it("a decoder ignores keys and reason codes it does not know", () => {
        const map = canMessageToCose({ verdict: "no", why: ["from-the-future"] })
        map.set("zz", "extra")
        expect(decodeCanMessageVerdict(encodeCose(map))).toEqual({
            verdict: "no",
            why: ["from-the-future"],
        })
        expect(() => canMessageFromCose(new Map([["v", "maybe"]]))).toThrow()
    })
})

describe("handleCanMessageRead", () => {
    const { deps } = depsFor(
        { [DID_B]: found("open") },
        { [`${DID_A}>${DID_B}`]: { blocks: "no", follows: "no" } }
    )
    const get = (path: string, init?: RequestInit) =>
        handleCanMessageRead(new Request(`https://relay.test${path}`, init), deps)

    it("GET /pmr/v1/can-message/{sender}/{recipient} answers 200 CBOR with cache-control no-store", async () => {
        const res = await get(`/pmr/v1/can-message/${DID_A}/${DID_B}`)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe("application/cbor")
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(decodeCanMessageVerdict(new Uint8Array(await res.arrayBuffer()))).toEqual({
            verdict: "yes",
            via: ["open"],
        })
    })

    it("an unserved recipient and a served recipient with no snapshot get byte-identical 404 no-store responses", async () => {
        const a = await get(`/pmr/v1/can-message/${DID_A}/did:plc:unserved`)
        const b = await get(`/pmr/v1/can-message/${DID_A}/did:plc:servednosnapshot`)
        expect(a.status).toBe(404)
        expect(a.headers.get("cache-control")).toBe("no-store")
        expect(b.status).toBe(404)
        expect(await b.text()).toBe(await a.text())
        expect([...b.headers]).toEqual([...a.headers])
    })

    it("a malformed path or DID is 400 no-store", async () => {
        for (const path of [
            `/pmr/v1/can-message/${DID_A}`,
            `/pmr/v1/can-message/${DID_A}/${DID_B}/extra`,
            `/pmr/v1/can-message/not-a-did/${DID_B}`,
            `/pmr/v1/can-message/${DID_A}/did:plc:%E0%A4%A`,
            `/pmr/v1/other/${DID_A}/${DID_B}`,
        ]) {
            const res = await get(path)
            expect(res.status, path).toBe(400)
            expect(res.headers.get("cache-control")).toBe("no-store")
        }
    })

    it("the response is identical for every caller, with no per-caller headers", async () => {
        const path = `/pmr/v1/can-message/${DID_A}/${DID_B}`
        const anon = await get(path)
        const authed = await get(path, {
            headers: { authorization: "Bearer x", cookie: "s=1", "x-forwarded-for": "1.2.3.4" },
        })
        expect(new Uint8Array(await authed.arrayBuffer())).toEqual(new Uint8Array(await anon.arrayBuffer()))
        expect([...authed.headers]).toEqual([...anon.headers])
        expect(anon.headers.get("set-cookie")).toBeNull()
        expect(anon.headers.get("etag")).toBeNull()
    })

    it("the body carries only CAN_MESSAGE_KEYS, whose arrays hold policy and reason ids, never DIDs", async () => {
        const unknown = depsFor({ [DID_B]: found("bsky-follows") })
        const res = await handleCanMessageRead(
            new Request(`https://relay.test/pmr/v1/can-message/${DID_A}/${DID_B}`),
            unknown.deps
        )
        const map = decodeCoseMap(new Uint8Array(await res.arrayBuffer()))
        const allowed = new Set<string>(Object.values(CAN_MESSAGE_KEYS))
        for (const [key, value] of map) {
            expect(allowed.has(String(key))).toBe(true)
            if (Array.isArray(value)) {
                for (const item of value) expect(String(item)).not.toMatch(/^did:/)
            }
        }
    })
})
