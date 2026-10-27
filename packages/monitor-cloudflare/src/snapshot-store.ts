import {
    DECLARATION_COLLECTION_NSID,
    declaredPoliciesOf,
    didWebDocumentURL,
    readRecordFromCar,
    type StoredPolicies,
    type RecordSnapshotStore,
    type SummaryIndexReader,
} from "@germ-network/atproto-pmr-core"
import type {
    DigestMarker,
    RecordRef,
    RefreshSnapshots,
    SecondarySnapshotStore,
    SnapshotCheck,
    SnapshotEntry,
    SnapshotEvidence,
    SnapshotStore,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/**
 * The serving half of the seam, on KV.
 *
 * KV rather than Durable Object storage because the read paths are public,
 * cacheable, and want to run in plain Workers near the caller — the
 * community view should scale like the public data it is, not funnel
 * through one object in one location. **No request handler reads through
 * the ingest object** — every read here, including the digest marker, is
 * this store or nothing, which is what keeps a read from ever sharing fate
 * with a wedged, evicted, or reconnecting writer. A handler may signal the
 * writer (a registration notify, a re-check request) but never reads
 * through it.
 *
 * Eventual consistency is acceptable here and only here: a stale record
 * read is `rev` skew, which the trust model already treats as ordinary,
 * and a stale digest marker read is the replication lag `serveDigest`
 * detects and stops at rather than silently papering over. `rev`
 * *comparisons* read the index instead — never this store.
 */

const RECORD_PREFIX = "rec:"
const WINDOW_PREFIX = "win:"
/** `chk:<did>` = {@link SnapshotCheck}: the last time `rec:` was confirmed current. */
const CHECK_PREFIX = "chk:"
/**
 * The KV keys of one record's snapshot and its confirmation. The declaration
 * keeps the bare `rec:<did>` / `chk:<did>` it has always had, so existing
 * snapshots need no migration; every other record is
 * `rec:<collection>/<rkey>:<did>` / `chk:<collection>/<rkey>:<did>`. The two
 * forms cannot collide: a DID starts `did:`, an NSID never does. Keys are
 * built, never parsed: an rkey containing `:` would make one ambiguous. KV caps
 * a key at 512 bytes, so a long collection and rkey can exceed it.
 */
export function snapshotKeys(
    did: string,
    collection: string,
    rkey: string
): { record: string; check: string } {
    if (collection === DECLARATION_COLLECTION_NSID && rkey === "self") {
        return { record: RECORD_PREFIX + did, check: CHECK_PREFIX + did }
    }
    const subject = `${collection}/${rkey}:${did}`
    return { record: RECORD_PREFIX + subject, check: CHECK_PREFIX + subject }
}

async function readEntry(
    env: { records: KVNamespace },
    ref: RecordRef
): Promise<SnapshotEntry | null> {
    const { value, metadata } = await env.records.getWithMetadata<StoredMeta>(
        snapshotKeys(ref.did, ref.collection, ref.rkey).record,
        "arrayBuffer"
    )
    if (value === null || metadata === null) return null
    return {
        rev: metadata.rev,
        commitCid: metadata.commitCid ?? null,
        car: new Uint8Array(value),
        observedAtMs: metadata.observedAtMs,
        source: metadata.source,
        signingKey: metadata.signingKey,
        verifiedWith: metadata.verifiedWith ?? null,
        cid: metadata.cid ?? null,
        seenKey: metadata.seenKey ?? null,
        evidence: storedEvidence(ref, metadata),
        messagingKeyFingerprint: metadata.messagingKeyFingerprint ?? null,
        messagingKeyFirstSeenAtMs: metadata.messagingKeyFirstSeenAtMs ?? null,
    }
}

/** Cloudflare KV's cap on one key's metadata, as UTF-8 bytes of its JSON. */
export const KV_METADATA_MAX_BYTES = 1024

async function writeEntry(
    env: { records: KVNamespace },
    key: string,
    entry: SnapshotEntry,
    policies?: StoredPolicies
): Promise<void> {
    const metadata: StoredMeta = {
        rev: entry.rev,
        commitCid: entry.commitCid ?? null,
        observedAtMs: entry.observedAtMs,
        source: entry.source,
        signingKey: entry.signingKey,
        verifiedWith: entry.verifiedWith,
        cid: entry.cid,
        seenKey: entry.seenKey ?? null,
        evidence: entry.evidence ? slimEvidence(entry.evidence) : null,
        ...(entry.messagingKeyFingerprint == null
            ? {}
            : { messagingKeyFingerprint: entry.messagingKeyFingerprint }),
        ...(entry.messagingKeyFirstSeenAtMs == null
            ? {}
            : { messagingKeyFirstSeenAtMs: entry.messagingKeyFirstSeenAtMs }),
        ...(policies ? { policies } : {}),
    }
    // A declaration must never fail to store over optional metadata: past the
    // cap the put is a 413 and the snapshot goes stale.
    const bytes = metadataBytes(metadata)
    if (bytes > KV_METADATA_MAX_BYTES) {
        metadata.evidence = null
        if (metadataBytes(metadata) > KV_METADATA_MAX_BYTES) delete metadata.messagingKeyFirstSeenAtMs
        if (metadataBytes(metadata) > KV_METADATA_MAX_BYTES) delete metadata.messagingKeyFingerprint
        const trimmedBytes = metadataBytes(metadata)
        if (trimmedBytes > KV_METADATA_MAX_BYTES) {
            console.error("monitor: snapshot metadata over cap after trim", { key, bytes, trimmedBytes })
        } else {
            console.warn("monitor: snapshot metadata trimmed", { key, bytes, trimmedBytes })
        }
    }
    // No expirationTtl, deliberately: an unchanged record must stay served
    // indefinitely.
    await env.records.put(key, entry.car, { metadata })
}

const metadataBytes = (metadata: StoredMeta) =>
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength

/**
 * The part of a {@link SnapshotEvidence} the metadata does not already hold.
 * The rest is the record's path, `cid`, `commitCid`, `rev` and
 * `verifiedWith`, which `storedEvidence` rebuilds it from.
 */
interface StoredEvidenceMeta {
    authority: StoredAuthority
    assurance: SnapshotEvidence["assurance"]
    monitor: string
    commitFirstObservedAtMs: number
    anchorFirstObservedAtMs: number
}

/**
 * A did:web authority without what the DID implies: `documentUrl` when it is
 * the DID's own document URL, and `verificationMethodId` when it is
 * `<did>#atproto`. Each repeats the DID's host, which put a did:web
 * declaration's evidence over the cap.
 */
type StoredAuthority =
    | Extract<SnapshotEvidence["authority"], { method: "plc" }>
    | {
          method: "web"
          keyFingerprint: string
          documentUrl?: string
          verificationMethodId?: string
      }

const impliedDocumentUrl = (did: string): string | null => {
    try {
        return new URL(didWebDocumentURL(did)).href
    } catch {
        return null
    }
}

function slimEvidence(evidence: SnapshotEvidence): StoredEvidenceMeta {
    const { authority } = evidence
    return {
        authority:
            authority.method === "plc"
                ? authority
                : {
                      method: "web",
                      keyFingerprint: authority.keyFingerprint,
                      ...(authority.documentUrl === impliedDocumentUrl(evidence.did)
                          ? {}
                          : { documentUrl: authority.documentUrl }),
                      ...(authority.verificationMethodId === `${evidence.did}#atproto`
                          ? {}
                          : { verificationMethodId: authority.verificationMethodId }),
                  },
        assurance: evidence.assurance,
        monitor: evidence.monitor,
        commitFirstObservedAtMs: evidence.commitFirstObservedAtMs,
        anchorFirstObservedAtMs: evidence.anchorFirstObservedAtMs,
    }
}

/**
 * The full evidence for the record at `ref`, from either stored shape. An
 * entry stored before evidence was slimmed carries the full object, which
 * reads as it was written.
 */
function storedEvidence(ref: RecordRef, metadata: StoredMeta): SnapshotEvidence | null {
    const stored = metadata.evidence
    if (!stored) return null
    if ("did" in stored) return stored
    const { cid, commitCid, rev, verifiedWith } = metadata
    if (cid == null || commitCid == null || verifiedWith == null) return null
    const { authority } = stored
    let fullAuthority: SnapshotEvidence["authority"]
    if (authority.method === "plc") {
        fullAuthority = authority
    } else {
        const documentUrl = authority.documentUrl ?? impliedDocumentUrl(ref.did)
        if (documentUrl === null) return null
        fullAuthority = {
            method: "web",
            documentUrl,
            verificationMethodId: authority.verificationMethodId ?? `${ref.did}#atproto`,
            keyFingerprint: authority.keyFingerprint,
        }
    }
    return {
        did: ref.did,
        collection: ref.collection,
        rkey: ref.rkey,
        recordCid: cid,
        commitCid,
        rev,
        verifiedWith,
        ...stored,
        authority: fullAuthority,
    }
}

/** Singleton key — one marker for the whole digest, not one per window.
 * Exported so a test can reset it directly: `env.records` is shared across
 * tests in this package's suite (KV, unlike Durable Object storage, is not
 * reset per test), and this is the one entry with no per-test-unique key
 * to naturally avoid collision the way record and window keys do. */
export const DIGEST_MARKER_KEY = "digest:marker"

/** Stored beside the bytes so a reader knows what it holds without the index. */
interface StoredMeta {
    rev: string
    commitCid?: string | null
    observedAtMs: number
    source: string
    signingKey: string | null
    verifiedWith: string | null
    cid: string | null
    seenKey: string | null
    /** Slim since the metadata cap was hit; the full shape on older entries. */
    evidence?: StoredEvidenceMeta | SnapshotEvidence | null
    /** Internal currentKey history metadata; absent on legacy snapshots. */
    messagingKeyFingerprint?: string | null
    messagingKeyFirstSeenAtMs?: number | null
    /**
     * The declaration's decoded policies; absent on entries stored before
     * they were kept and on any entry ingest did not verify.
     */
    policies?: StoredPolicies
}

/**
 * The policies `putRecord` stores beside a verified declaration CAR (only
 * `putRecord`, never `putSecondary`), so a verdict read needs no CAR parse:
 * `declaredPoliciesOf` over the CAR's record, or `undecodable` when the CAR
 * holds no readable declaration.
 */
export function declarationPoliciesMeta(car: Uint8Array): StoredPolicies {
    let record: unknown
    try {
        record = readRecordFromCar(car, DECLARATION_COLLECTION_NSID, "self")?.record
    } catch {
        return { found: false, code: "undecodable" }
    }
    const declared = declaredPoliciesOf(record)
    return declared.found ? declared : { found: false, code: "undecodable" }
}

/**
 * Generic over the Durable Object class for the same reason `PMREnv` is: a
 * deployment subclasses `MonitorIngest` to supply the authoritative fetch,
 * and `protected fetchRecord` makes the subclass non-assignable to the
 * base. Without the parameter every adopter who followed that advice would
 * hit a type error here.
 */
export function kvSnapshotStore<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): SnapshotStore & RefreshSnapshots & SecondarySnapshotStore {
    return {
        getRecord: (did) =>
            readEntry(env, { did, collection: DECLARATION_COLLECTION_NSID, rkey: "self" }),

        putRecord: (did, entry) =>
            writeEntry(
                env,
                RECORD_PREFIX + did,
                entry,
                entry.verifiedWith === null ? undefined : declarationPoliciesMeta(entry.car)
            ),

        async deleteRecord(did: string): Promise<void> {
            await env.records.delete(RECORD_PREFIX + did)
            // A confirmation of a CAR that no longer exists must not outlive it.
            await env.records.delete(CHECK_PREFIX + did)
        },

        async putCheck(did: string, check: SnapshotCheck): Promise<void> {
            await env.records.put(CHECK_PREFIX + did, JSON.stringify(check))
        },

        getSecondary: (ref) => readEntry(env, ref),

        putSecondary: (ref, entry) =>
            writeEntry(env, snapshotKeys(ref.did, ref.collection, ref.rkey).record, entry),

        async deleteSecondary(ref: RecordRef): Promise<void> {
            const keys = snapshotKeys(ref.did, ref.collection, ref.rkey)
            await env.records.delete(keys.record)
            await env.records.delete(keys.check)
        },

        async putSecondaryCheck(ref: RecordRef, check: SnapshotCheck): Promise<void> {
            await env.records.put(
                snapshotKeys(ref.did, ref.collection, ref.rkey).check,
                JSON.stringify(check)
            )
        },

        async getSealedWindow(windowId: string): Promise<Uint8Array | null> {
            const v = await env.records.get(WINDOW_PREFIX + windowId, "arrayBuffer")
            return v === null ? null : new Uint8Array(v)
        },

        async putSealedWindow(windowId: string, filter: Uint8Array): Promise<void> {
            // Windows DO expire, unlike records: past the published
            // retention a client falls back to direct re-verification,
            // which is the cost it would pay with no digest at all. The
            // comment used to say this while the code kept them forever.
            // Applies equally to an empty window's entry — it expires on
            // the same schedule as the `oldest` floor `sealDueWindows`
            // publishes for it, so the two never disagree about whether a
            // window is still supposed to be readable.
            const ttl = Number.parseInt(env.WINDOW_RETENTION_SECONDS, 10)
            await env.records.put(WINDOW_PREFIX + windowId, filter, {
                expirationTtl: Number.isFinite(ttl) ? Math.max(60, ttl) : undefined,
            })
        },

        async getDigestMarker(): Promise<DigestMarker | null> {
            return env.records.get<DigestMarker>(DIGEST_MARKER_KEY, "json")
        },

        async putDigestMarker(marker: DigestMarker): Promise<void> {
            // No TTL: this is the one entry that must never expire on its
            // own schedule — its absence is a meaningful, explicit state
            // (`serveDigest` treats it as "nothing sealed yet"), not
            // something that should happen quietly under retention.
            await env.records.put(DIGEST_MARKER_KEY, JSON.stringify(marker))
        },
    }
}

/**
 * The relay's read of a sender's declaration snapshot: the `rec:` CAR, fresh
 * as of the later of its fetch and a `chk:` confirmation at the same rev.
 * A `chk:` at any other rev is ignored.
 */
export function kvDeclarationSnapshots<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): (did: string) => Promise<{ car: Uint8Array; freshAtMs: number } | null> {
    return async (did) => {
        const [{ value, metadata }, check] = await Promise.all([
            env.records.getWithMetadata<StoredMeta>(RECORD_PREFIX + did, "arrayBuffer"),
            env.records.get<SnapshotCheck>(CHECK_PREFIX + did, "json"),
        ])
        if (value === null || metadata === null) return null
        const confirmedAtMs =
            check !== null && check.rev === metadata.rev ? check.checkedAtMs : 0
        return {
            car: new Uint8Array(value),
            freshAtMs: Math.max(metadata.observedAtMs, confirmedAtMs),
        }
    }
}

/**
 * The read surface over every kept record, the declaration and the
 * secondaries alike, keyed by `snapshotKeys`. `freshAtMs` is the later of the
 * fetch and a `chk:` confirmation at the same rev as that record; a `chk:` at
 * any other rev is ignored. An entry stored without verified metadata reads
 * `verifiedWith`, `rev` and `cid` as null.
 */
export function kvRecordSnapshots<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): RecordSnapshotStore {
    return {
        async get(did, collection, rkey) {
            const keys = snapshotKeys(did, collection, rkey)
            const [{ value, metadata }, check] = await Promise.all([
                env.records.getWithMetadata<StoredMeta>(keys.record, "arrayBuffer"),
                env.records.get<SnapshotCheck>(keys.check, "json"),
            ])
            if (value === null || metadata === null) return null
            const verifiedWith = metadata.verifiedWith ?? null
            const confirmedAtMs =
                check !== null && check.rev === metadata.rev ? check.checkedAtMs : 0
            return {
                car: new Uint8Array(value),
                freshAtMs: Math.max(metadata.observedAtMs, confirmedAtMs),
                verifiedWith,
                // An entry stored before ingest verified carries an unsigned rev.
                rev: verifiedWith === null ? null : metadata.rev,
                cid: verifiedWith === null ? null : (metadata.cid ?? null),
                commitCid: verifiedWith === null ? null : (metadata.commitCid ?? null),
                evidence: storedEvidence({ did, collection, rkey }, metadata),
                ...(metadata.policies ? { policies: metadata.policies } : {}),
            }
        },
    }
}

/**
 * The summary's index reads: each ref's `rec:` metadata and `chk:` entry in
 * bulk reads of up to a hundred keys, never a CAR (a bulk read cannot return
 * bytes, and the value is discarded). An entry stored without verified
 * metadata reads as null, as does one with no `cid`.
 */
export function kvSummaryIndexReader<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): SummaryIndexReader {
    return {
        async entries(refs) {
            const keys = refs.map((r) => snapshotKeys(r.did, r.collection, r.rkey))
            const records = new Map<string, StoredMeta | null>()
            const checks = new Map<string, SnapshotCheck | null>()
            for (let i = 0; i < keys.length; i += KV_BULK_READ_MAX) {
                const chunk = keys.slice(i, i + KV_BULK_READ_MAX)
                const [recs, chks] = await Promise.all([
                    env.records.getWithMetadata<StoredMeta>(
                        chunk.map((k) => k.record),
                        "text"
                    ),
                    env.records.get<SnapshotCheck>(
                        chunk.map((k) => k.check),
                        "json"
                    ),
                ])
                for (const [key, entry] of recs) records.set(key, entry?.metadata ?? null)
                for (const [key, check] of chks) checks.set(key, check)
            }
            return refs.map((ref, i) => {
                const metadata = records.get(keys[i]!.record)
                if (!metadata) return null
                const { verifiedWith, cid } = metadata
                if (verifiedWith === null || verifiedWith === undefined) return null
                if (cid === null || cid === undefined) return null
                const check = checks.get(keys[i]!.check) ?? null
                const confirmedAtMs = check !== null && check.rev === metadata.rev ? check.checkedAtMs : 0
                return {
                    ...ref,
                    cid,
                    verifiedWith,
                    commitCid: metadata.commitCid ?? null,
                    rev: metadata.rev ?? null,
                    freshAtMs: Math.max(metadata.observedAtMs, confirmedAtMs),
                    evidenceState: storedEvidence(ref, metadata),
                    messagingKeyFirstSeenAtMs: metadata.messagingKeyFirstSeenAtMs ?? null,
                    ...(metadata.policies ? { policies: metadata.policies } : {}),
                }
            })
        },
    }
}

/** Batched private read of messaging-key first-seen metadata for public pair ranking. */
export async function kvMessagingKeyFirstSeenMany(
    env: { records: KVNamespace },
    dids: readonly string[]
): Promise<Map<string, number | null>> {
    const distinct = [...new Set(dids)]
    const out = new Map<string, number | null>()
    for (let i = 0; i < distinct.length; i += KV_BULK_READ_MAX) {
        const chunk = distinct.slice(i, i + KV_BULK_READ_MAX)
        const keys = chunk.map((did) => snapshotKeys(did, DECLARATION_COLLECTION_NSID, "self").record)
        const rows = await env.records.getWithMetadata<StoredMeta>(keys, "text")
        for (const did of chunk) {
            const key = snapshotKeys(did, DECLARATION_COLLECTION_NSID, "self").record
            const metadata = rows.get(key)?.metadata
            out.set(did, metadata?.messagingKeyFirstSeenAtMs ?? null)
        }
    }
    return out
}

/** Keys one KV bulk read accepts. */
const KV_BULK_READ_MAX = 100
