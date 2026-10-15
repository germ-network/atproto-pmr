import { allowPoliciesOf, readAnchorPolicy } from "./anchor-policy.js"
import { decodeCoseMap, encodeCose, type CoseValue } from "./cose/cbor.js"
import { DID_SYNTAX } from "./device-read.js"
import type { AllowPolicy, DeclaredPolicies } from "./policy.js"
import { SNAPSHOT_MAX_AGE_MS, type SnapshotRecordRead, type StoredRecordSnapshot } from "./snapshot-read.js"
import { toResponseBody } from "./util.js"

export type { AllowPolicy, DeclaredPolicies, StoredPolicies } from "./policy.js"

/**
 * The "can A message B?" oracle: a public verdict on whether sender A may
 * open a conversation with recipient B, computed per request from B's
 * declared allow policies and the Bluesky graph. It gives per-pair
 * verdicts, one sender at a time; it serves verdicts, not follow or block lists.
 *
 * A declaration carries a set of allow policies; the verdict names every one
 * under which A may contact B. Bluesky is the main social graph but not the
 * only one, so a policy names the graph it reads. Blocks are different: a
 * Bluesky block is a veto over every policy, because there are many social
 * graphs but one block graph.
 */

/**
 * Why the answer is no:
 * - `no-declaration` — B holds no Germ declaration.
 * - `blocked` — B blocks A on Bluesky.
 * - `not-admitted` — none of B's policies admits A (B declares none, or
 *   every one is known to refuse A).
 */
export type CanMessageNoReason = "no-declaration" | "blocked" | "not-admitted" | (string & {})

/**
 * Why the answer is unknown:
 * - `declaration-unavailable` — a snapshot of B's declaration is held but
 *   cannot be served now (unverifiable, or out of date at the PDS).
 * - `policy-undecodable` — B's declaration is held but its policy cannot be read.
 * - `policy-unrecognized` — a policy B declares is not one this relay evaluates.
 * - `graph-incomplete` — a follow the policy depends on is not kept for this pair.
 * - `block-unknown` — whether B blocks A is not kept for this pair.
 */
export type CanMessageUnknownReason =
    | "declaration-unavailable"
    | "policy-undecodable"
    | "policy-unrecognized"
    | "graph-incomplete"
    | "block-unknown"
    | (string & {})

export type CanMessageVerdict =
    | { verdict: "yes"; via: AllowPolicy[] }
    | { verdict: "no"; why: CanMessageNoReason[] }
    | { verdict: "unknown"; pending: AllowPolicy[]; why: CanMessageUnknownReason[] }

/**
 * A graph fact for one ordered pair. `unknown` when the relay's keep rules
 * do not retain that pair's edges, so its absence proves nothing.
 */
export type PairFact = "yes" | "no" | "unknown"

/**
 * Where B's allow policies come from. Today the signed `AnchorPolicy` inside
 * the declaration's keyPackage; a declaration that lists policies directly
 * would be another source with no change to the verdict.
 */
export interface PolicySource {
    /** Null when the relay holds nothing for B. */
    policiesOf(recipient: string): Promise<DeclaredPolicies | null>
}

/** What the graph says about one recipient B, for a fixed sender A. */
export interface RecipientGraphFacts {
    /** Whether B blocks A. */
    blocks: PairFact
    /** Whether B follows A. */
    follows: PairFact
}

/**
 * Graph lookups for one sender against many recipients, batched because the
 * sender is fixed. A fact is `unknown` unless the recipient's graph is
 * served: only a served graph's edges are complete, so only there does a
 * missing edge mean no.
 */
export interface SenderGraphReader {
    /** One entry per distinct recipient. */
    forSender(sender: string, recipients: readonly string[]): Promise<Map<string, RecipientGraphFacts>>
}

export interface CanMessageFacts {
    declared: DeclaredPolicies
    /** Whether B blocks A. */
    blocked: PairFact
    /** Whether B follows A. */
    followed: PairFact
}

/** The verdict for one pair. Pure. */
export function evaluateCanMessage(facts: CanMessageFacts): CanMessageVerdict {
    const { declared, blocked, followed } = facts
    if (!declared.found) {
        switch (declared.code) {
            case "no-declaration":
                return { verdict: "no", why: ["no-declaration"] }
            case "unavailable":
                return { verdict: "unknown", pending: [], why: ["declaration-unavailable"] }
            case "undecodable":
                return { verdict: "unknown", pending: [], why: ["policy-undecodable"] }
        }
    }
    if (blocked === "yes") return { verdict: "no", why: ["blocked"] }

    const admitting: AllowPolicy[] = []
    const pending: AllowPolicy[] = []
    const reasons: CanMessageUnknownReason[] = []
    const pend = (policy: AllowPolicy, reason: CanMessageUnknownReason): void => {
        pending.push(policy)
        if (!reasons.includes(reason)) reasons.push(reason)
    }
    for (const policy of declared.policies) {
        if (policy === "open") admitting.push(policy)
        else if (policy === "bsky-follows") {
            if (followed === "yes") admitting.push(policy)
            else if (followed === "unknown") pend(policy, "graph-incomplete")
        } else pend(policy, "policy-unrecognized")
    }

    if (blocked === "no") {
        if (admitting.length > 0) return { verdict: "yes", via: admitting }
        if (pending.length > 0) return { verdict: "unknown", pending, why: reasons }
        return { verdict: "no", why: ["not-admitted"] }
    }
    const open = [...admitting, ...pending]
    if (open.length === 0) return { verdict: "no", why: ["not-admitted"] }
    return { verdict: "unknown", pending: open, why: ["block-unknown", ...reasons] }
}

export interface CanMessageDeps {
    policies: PolicySource
    graph: SenderGraphReader
}

/**
 * The verdict for `sender` → `recipient`, or null when the relay holds
 * nothing for the recipient. Every surface that reports a verdict (the
 * public route, the owner summary, a receive-time check) goes through this
 * or {@link computeCanMessageMany}, so the rule lives in one place.
 */
export async function computeCanMessage(
    sender: string,
    recipient: string,
    deps: CanMessageDeps
): Promise<CanMessageVerdict | null> {
    return (await computeCanMessageMany(sender, [recipient], deps)).get(recipient) ?? null
}

/**
 * {@link computeCanMessage} for one sender and many recipients, with one
 * graph read for all of them. Recipients the relay holds nothing for are
 * absent from the map.
 */
export async function computeCanMessageMany(
    sender: string,
    recipients: readonly string[],
    deps: CanMessageDeps
): Promise<Map<string, CanMessageVerdict>> {
    const distinct = [...new Set(recipients)]
    const held = new Map<string, DeclaredPolicies>()
    for (const recipient of distinct) {
        const declared = await deps.policies.policiesOf(recipient)
        if (declared) held.set(recipient, declared)
    }
    const verdicts = new Map<string, CanMessageVerdict>()
    if (held.size === 0) return verdicts

    const facts = await deps.graph.forSender(sender, [...held.keys()])
    for (const [recipient, declared] of held) {
        const graph = facts.get(recipient)
        verdicts.set(
            recipient,
            evaluateCanMessage({
                declared,
                blocked: graph?.blocks ?? "unknown",
                followed: graph?.follows ?? "unknown",
            })
        )
    }
    return verdicts
}

function parseCanMessagePath(pathname: string): { sender: string; recipient: string } | null {
    const parts = pathname.split("/")
    // "", "pmr", "v1", "can-message", sender, recipient
    if (parts.length !== 6 || parts[1] !== "pmr" || parts[2] !== "v1" || parts[3] !== "can-message") {
        return null
    }
    try {
        const [sender, recipient] = parts.slice(4).map(decodeURIComponent)
        if (!DID_SYNTAX.test(sender!) || !DID_SYNTAX.test(recipient!)) return null
        return { sender: sender!, recipient: recipient! }
    } catch {
        return null
    }
}

/**
 * `GET /pmr/v1/can-message/{sender}/{recipient}` — the pair's
 * {@link CanMessageVerdict} as CBOR, `cache-control: no-store`; one uniform
 * `404` when the relay holds nothing for the recipient, served or not, `400`
 * for a malformed path.
 * A hint: the recipient's device enforces its own policy on first contact.
 */
export async function handleCanMessageRead(
    request: Request,
    deps: CanMessageDeps
): Promise<Response> {
    const headers = { "cache-control": "no-store" }
    const pair = parseCanMessagePath(new URL(request.url).pathname)
    if (!pair) return new Response("Malformed path", { status: 400, headers })
    const verdict = await computeCanMessage(pair.sender, pair.recipient, deps)
    if (!verdict) return new Response("Not found", { status: 404, headers })
    return new Response(toResponseBody(encodeCanMessageVerdict(verdict)), {
        status: 200,
        headers: { ...headers, "content-type": "application/cbor" },
    })
}

type FieldsOf<T> = T extends unknown ? keyof T : never
type WireKeys<T> = { readonly [K in FieldsOf<T>]: string }

export const CAN_MESSAGE_KEYS = {
    verdict: "v",
    via: "a",
    pending: "p",
    why: "r",
} as const satisfies WireKeys<CanMessageVerdict>

/** The verdict as a CBOR map under {@link CAN_MESSAGE_KEYS}, for embedding in another body. */
export function canMessageToCose(verdict: CanMessageVerdict): Map<string, CoseValue> {
    const K = CAN_MESSAGE_KEYS
    switch (verdict.verdict) {
        case "yes":
            return new Map<string, CoseValue>([[K.verdict, "yes"], [K.via, [...verdict.via]]])
        case "no":
            return new Map<string, CoseValue>([[K.verdict, "no"], [K.why, [...verdict.why]]])
        case "unknown":
            return new Map<string, CoseValue>([
                [K.verdict, "unknown"],
                [K.pending, [...verdict.pending]],
                [K.why, [...verdict.why]],
            ])
    }
}

/** Inverse of {@link canMessageToCose}; ignores keys it does not know. */
export function canMessageFromCose(map: Map<number | string, CoseValue>): CanMessageVerdict {
    const K = CAN_MESSAGE_KEYS
    const strings = (key: string): string[] => {
        const v = map.get(key)
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
            throw new Error(`can-message: missing or malformed field "${key}"`)
        }
        return v as string[]
    }
    const verdict = map.get(K.verdict)
    switch (verdict) {
        case "yes":
            return { verdict, via: strings(K.via) }
        case "no":
            return { verdict, why: strings(K.why) }
        case "unknown":
            return { verdict, pending: strings(K.pending), why: strings(K.why) }
        default:
            throw new Error("can-message: unrecognized verdict")
    }
}

/** `encodeCose(canMessageToCose(verdict))`. */
export function encodeCanMessageVerdict(verdict: CanMessageVerdict): Uint8Array {
    return encodeCose(canMessageToCose(verdict))
}

/** Inverse of {@link encodeCanMessageVerdict}; ignores keys it does not know. */
export function decodeCanMessageVerdict(bytes: Uint8Array): CanMessageVerdict {
    return canMessageFromCose(decodeCoseMap(bytes))
}

/**
 * B's policies from its decoded declaration record: the keyPackage's
 * `AnchorPolicy`, mapped by `allowPoliciesOf`. For a caller that already
 * holds the record, so a policy source needs no second read.
 * `messageMe.showButtonTo` is not read: it is a UI hint, not the policy.
 */
export function declaredPoliciesOf(record: unknown): DeclaredPolicies {
    const keyPackage = (record as { keyPackage?: unknown } | null)?.keyPackage
    if (!(keyPackage instanceof Uint8Array)) return { found: false, code: "undecodable" }
    try {
        return { found: true, policies: allowPoliciesOf(readAnchorPolicy(keyPackage)) }
    } catch {
        return { found: false, code: "undecodable" }
    }
}

export interface SnapshotPolicySourceDeps {
    /** Whether this deployment serves the DID's records. */
    serves: (did: string) => Promise<boolean>
    /**
     * Asks the monitor to re-check a declaration past `SNAPSHOT_MAX_AGE_MS`,
     * as the record read does (`dedupedRecheck`); off the response path.
     */
    recheck?: (did: string) => void
    /** The held declaration snapshot with its stored metadata, or null. */
    snapshot: (did: string) => Promise<StoredRecordSnapshot | null>
    /** Defaults to `Date.now`. */
    nowMs?: () => number
    /**
     * The verified declaration read (`snapshotRecordReader` for the
     * declaration), for a snapshot stored without decoded policies. Build it
     * with a `fetchDirect` that throws, so a lapsed snapshot is served as
     * held and the response never reaches a PDS.
     */
    readDeclaration: (did: string) => Promise<SnapshotRecordRead>
}

/**
 * B's policies from the declaration snapshot the monitor holds: the policies
 * decoded when ingest stored and verified it, or, for a snapshot stored
 * before those were kept, {@link declaredPoliciesOf} over the verified
 * record. A snapshot ingest did not verify reads `unavailable`. Null both for a
 * DID this deployment does not serve and for a served DID with no snapshot
 * held: neither can be told apart from a DID whose declaration has not been
 * fetched yet, so neither is answered `no-declaration`. A verdict is a hint,
 * so stored policies are used without re-verifying the CAR per read.
 */
export function snapshotPolicySource(deps: SnapshotPolicySourceDeps): PolicySource {
    const nowMs = deps.nowMs ?? Date.now
    return {
        async policiesOf(did) {
            if (!(await deps.serves(did))) return null
            const snapshot = await deps.snapshot(did)
            if (!snapshot) return null
            if (snapshot.verifiedWith === null) return { found: false, code: "unavailable" }
            if (!(nowMs() - snapshot.freshAtMs <= SNAPSHOT_MAX_AGE_MS)) deps.recheck?.(did)
            if (snapshot.policies) return snapshot.policies
            const read = await deps.readDeclaration(did)
            if (!read.found) return { found: false, code: "unavailable" }
            return declaredPoliciesOf(read.record)
        },
    }
}
