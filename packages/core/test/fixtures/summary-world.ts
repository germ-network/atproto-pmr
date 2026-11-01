import { ed25519 } from "@noble/curves/ed25519.js"
import { encodeBinding } from "../../src/challenge"
import { encodeOkpEd25519Key } from "../../src/cose/key"
import { handleSummaryRead, type OwnerDeps } from "../../src/owner/endpoints"
import type { OwnerGraph } from "../../src/owner-graph"
import { signRequest } from "../../src/http-sig/sign"
import type { RecordSnapshotStore } from "../../src/snapshot-read"
import type { ChallengeStore, Directory, Locator, PMRStore, RegistrationFields } from "../../src/storage"
import { decodeSummaryDelta, SUMMARY_TOKENS_KEPT, type SummaryIndex, type SummaryPageDeps } from "../../src/summary"
import { DECLARATION_COLLECTION_NSID } from "../../src/declaration"
import type { RecipientGraphFacts, StoredPolicies } from "../../src/can-message"
import type { PlcCoverage } from "../../src/did-document"
import type { FirehoseCoverage } from "../../src/firehose-coverage"
import { buildRepoCar, cidString, makeKey } from "./repo-car"

/** An in-memory owner summary endpoint: stores, a monitor and a signed-request client. */
export const COLLECTION = "app.example.thing"
export const WATCHED = [{ collection: COLLECTION, rkey: "self" }]
export const OWNER = "did:plc:alice0000000000000000"
export const OTHER_OWNER = "did:plc:bob00000000000000000000"
export const PEER = "did:plc:peer0000000000000000000"
export const URL_BASE = "https://relay.example/pmr/v1/summary"
export const T0 = 1_760_000_000

export function summaryWorld(options: { watched?: SummaryPageDeps["watched"] } = {}) {
    const registrations = new Map<string, RegistrationFields>()
    const challenges = (() => {
        const rows = new Map<string, string>()
        return {
            async mint(c: string, boundTo: string) {
                rows.set(c, boundTo)
            },
            async consume(c: string) {
                const v = rows.get(c)
                if (v === undefined) return null
                rows.delete(c)
                return v
            },
        } as ChallengeStore
    })()
    const directory = {
        async resolve(did: string): Promise<Locator | null> {
            return registrations.has(did) ? `loc:${did}` : null
        },
        async create(did: string, registration: RegistrationFields): Promise<Locator> {
            if (!registrations.has(did)) registrations.set(did, registration)
            return `loc:${did}`
        },
    } as unknown as Directory

    // The served-state store, as the PMRStore contract describes it.
    const served = new Map<string, { token: string; index: SummaryIndex }[]>()
    const puts: { locator: string; token: string }[] = []
    const store = (locator: Locator): PMRStore =>
        ({
            load: async () => registrations.get(locator.slice(4)) ?? null,
            async putSummaryIndex(token: string, index: SummaryIndex, _servedAtMs: number, replaces?: string) {
                puts.push({ locator, token })
                const list = (served.get(locator) ?? []).filter(
                    (e) => e.token !== token && e.token !== replaces
                )
                list.push({ token, index })
                served.set(locator, list.slice(-SUMMARY_TOKENS_KEPT))
            },
            async getSummaryIndex(token: string) {
                return served.get(locator)?.find((e) => e.token === token)?.index ?? null
            },
        }) as unknown as PMRStore

    // What the monitor holds: a record per DID at a version; absent unless set.
    const versions = new Map<string, number>()
    const key = makeKey()
    const ownGraphs = new Map<string, OwnerGraph>()
    const blocks = new Map<string, { blocker: string; rkey: string; subject: string }[]>()
    const blocksFail = new Set<string>()
    const graphFail = new Set<string>()
    const notServed = new Set<string>()
    const reads: string[] = []
    const coverage: { firehose: FirehoseCoverage | null; plc: PlcCoverage | null; fail: boolean } = {
        firehose: null,
        plc: null,
        fail: false,
    }
    /** The first touch of coverage, the owner's graph and any record, in order. */
    const order: string[] = []
    const repos = new Map<string, ReturnType<typeof buildRepoCar>>()
    const repoOf = (did: string, collection: string, rkey: string) => {
        const version = versions.get(did)
        if (version === undefined) return null
        const cacheKey = `${did}|${collection}/${rkey}@${version}`
        if (!repos.has(cacheKey)) {
            repos.set(
                cacheKey,
                buildRepoCar({
                    did,
                    key,
                    records: { [`${collection}/${rkey}`]: { $type: collection, did, version } },
                })
            )
        }
        return repos.get(cacheKey)!
    }
    const unreadable = new Set<string>()
    const records: RecordSnapshotStore = {
        async get(did, collection, rkey) {
            order.push("car")
            reads.push(`${did}|${collection}/${rkey}`)
            if (unreadable.has(did)) return null
            const repo = repoOf(did, collection, rkey)
            if (!repo) return null
            return {
                car: repo.car,
                freshAtMs: 0,
                verifiedWith: key.multikey,
                rev: "3kaaaaaaaaaaa",
                commitCid: cidString(repo.root),
                cid: repo.recordCids[`${collection}/${rkey}`]!,
            }
        },
    }
    // The declarations the index holds with stored policies, and the owner -> contact facts the sender graph answers.
    const declared = new Map<string, StoredPolicies>()
    const messagingKeyFirstSeen = new Map<string, number | null>()
    const senderFacts = new Map<string, RecipientGraphFacts>()
    const senderAsked: { sender: string; recipients: string[] }[] = []
    const senderFail = new Set<string>()
    const senderGraph: SummaryPageDeps["senderGraph"] = {
        async forSender(sender, recipients) {
            senderAsked.push({ sender, recipients: [...recipients] })
            if (senderFail.has(sender)) throw new Error("d1 down")
            return new Map(
                recipients.flatMap((r) => {
                    const facts = senderFacts.get(`${sender}|${r}`)
                    return facts ? [[r, facts] as const] : []
                })
            )
        },
    }
    const index: SummaryPageDeps["index"] = {
        async entries(refs) {
            return refs.map((r) => {
                const repo = repoOf(r.did, r.collection, r.rkey)
                return repo === null
                    ? null
                    : {
                          ...r,
                          cid: repo.recordCids[`${r.collection}/${r.rkey}`]!,
                          verifiedWith: key.multikey,
                          commitCid: cidString(repo.root),
                          rev: "3kaaaaaaaaaaa",
                          evidenceState: null,
                          freshAtMs: T0 * 1000,
                          messagingKeyFirstSeenAtMs:
                              r.collection === DECLARATION_COLLECTION_NSID && r.rkey === "self"
                                  ? (messagingKeyFirstSeen.get(r.did) ?? null)
                                  : null,
                          ...(r.collection === DECLARATION_COLLECTION_NSID && declared.has(r.did)
                              ? { policies: declared.get(r.did)! }
                              : {}),
                      }
            })
        },
    }
    const edge = (did: string): OwnerGraph["following"][number] => ({ did, mutual: false })
    ownGraphs.set(OWNER, { did: OWNER, following: [edge(PEER)], followers: [] })
    ownGraphs.set(OTHER_OWNER, { did: OTHER_OWNER, following: [], followers: [] })
    versions.set(OWNER, 1)
    versions.set(OTHER_OWNER, 1)
    versions.set(PEER, 1)

    let n = 0
    const deps: OwnerDeps & SummaryPageDeps & { randomBytes: (n: number) => Uint8Array; pageRecords?: number } = {
        challenges,
        directory,
        resolveLocator: (did) => directory.resolve(did),
        store,
        nowSeconds: T0,
        discardWindowSeconds: 3600,
        graph: {
            ownGraph: async (did) => {
                order.push("index")
                if (graphFail.has(did)) throw new Error("d1 down")
                return ownGraphs.get(did) ?? null
            },
        },
        blocks: {
            ownBlocks: async (did) => {
                if (blocksFail.has(did)) throw new Error("d1 down")
                return blocks.get(did) ?? (notServed.has(did) ? null : [])
            },
        },
        records,
        index,
        senderGraph,
        signingKeys: {
            keysFor: async (dids) =>
                new Map(dids.map((d) => [d, { kind: "trusted", key: key.multikey } as const])),
        },
        getFirehoseCoverage: async () => {
            order.push("coverage")
            if (coverage.fail) throw new Error("kv down")
            return coverage.firehose
        },
        getPlcCoverage: async () => coverage.plc,
        onLapse: () => {},
        watched: options.watched ?? WATCHED,
        randomBytes: (len) => {
            n += 1
            const bytes = new Uint8Array(len)
            new DataView(bytes.buffer).setUint32(0, n)
            return bytes
        },
        nowMs: () => T0 * 1000 + n,
    }
    return {
        deps,
        registrations,
        directory,
        challenges,
        versions,
        ownGraphs,
        blocks,
        blocksFail,
        graphFail,
        notServed,
        served,
        puts,
        reads,
        coverage,
        order,
        unreadable,
        declared,
        messagingKeyFirstSeen,
        senderFacts,
        senderAsked,
        senderFail,
    }
}

export async function owner(w: ReturnType<typeof summaryWorld>, did: string) {
    const secretKey = ed25519.utils.randomSecretKey()
    await w.directory.create(did, {
        did,
        anchorKey: encodeOkpEd25519Key({ x: ed25519.getPublicKey(secretKey) }),
        lastActive: T0,
    })
    return async (since?: string): Promise<Response> => {
        const c = `chal-${Math.random().toString(36).slice(2)}`
        await w.challenges.mint(c, encodeBinding({ realm: "anchor", subject: did }), T0 + 600)
        const url = since === undefined ? URL_BASE : `${URL_BASE}?since=${encodeURIComponent(since)}`
        const parts = signRequest({ method: "GET", url, nonce: c, keyid: "t", secretKey })
        return handleSummaryRead(new Request(url, { method: "GET", headers: parts.headers }), w.deps)
    }
}
export const read = async (res: Response) => decodeSummaryDelta(new Uint8Array(await res.arrayBuffer()))
export const dids = (d: { records: { did: string }[] }) => d.records.map((r) => r.did).sort()
