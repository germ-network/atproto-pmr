import {
    DECLARATION_COLLECTION_NSID,
    declaredPoliciesOf,
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
    SnapshotStore,
} from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"
import {
    decodeSnapshotValue,
    encodeSnapshotValue,
    KV_METADATA_MAX_BYTES,
    readIndexMeta,
    slimEvidence,
    SnapshotMetadataTooLarge,
    snapshotIndexMetaBytes,
    storedEvidence,
    SNAPSHOT_FORMAT_VERSION,
    type SnapshotDetail,
    type SnapshotIndexMeta,
} from "./snapshot-layout"

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
 * snapshots keep their key; every other record is
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

/** A held entry's parts, decoded from a v2 value and metadata; `null` for anything else. */
function decodeEntry(
    value: ArrayBuffer | null,
    metadata: unknown,
    describe: string
): { meta: SnapshotIndexMeta; detail: SnapshotDetail; car: Uint8Array } | null {
    if (value === null || metadata === null) return null
    const meta = readIndexMeta(metadata)
    const decoded = meta === null ? null : decodeSnapshotValue(new Uint8Array(value))
    if (meta === null || decoded === null) {
        console.warn("monitor: snapshot entry not v2", { key: describe })
        return null
    }
    return { meta, ...decoded }
}

async function readEntry(
    env: { records: KVNamespace },
    ref: RecordRef
): Promise<SnapshotEntry | null> {
    const key = snapshotKeys(ref.did, ref.collection, ref.rkey).record
    const { value, metadata } = await env.records.getWithMetadata<unknown>(key, "arrayBuffer")
    const entry = decodeEntry(value, metadata, key)
    if (entry === null) return null
    const { meta, detail, car } = entry
    return {
        rev: meta.rev,
        commitCid: meta.commitCid,
        car,
        observedAtMs: meta.observedAtMs,
        source: detail.source,
        signingKey: detail.signingKey,
        verifiedWith: meta.verifiedWith,
        cid: meta.cid,
        evidence: storedEvidence(ref, meta),
        messagingKeyFirstSeenAtMs: meta.messagingKeyFirstSeenAtMs ?? null,
    }
}

/**
 * Stores `entry` as a v2 entry: bounded index metadata, and a value holding
 * the public detail and the CAR in one put. Throws over the metadata cap
 * rather than drop anything: every field is bounded, so exceeding it is a bug.
 */
async function writeEntry(
    env: { records: KVNamespace },
    key: string,
    entry: SnapshotEntry,
    policies?: StoredPolicies
): Promise<void> {
    const metadata: SnapshotIndexMeta = {
        v: SNAPSHOT_FORMAT_VERSION,
        rev: entry.rev,
        cid: entry.cid ?? null,
        commitCid: entry.commitCid ?? null,
        verifiedWith: entry.verifiedWith ?? null,
        observedAtMs: entry.observedAtMs,
        ...(policies ? { policies } : {}),
        ...(entry.messagingKeyFirstSeenAtMs == null
            ? {}
            : { messagingKeyFirstSeenAtMs: entry.messagingKeyFirstSeenAtMs }),
        evidence: entry.evidence ? slimEvidence(entry.evidence) : null,
    }
    const bytes = snapshotIndexMetaBytes(metadata)
    if (bytes > KV_METADATA_MAX_BYTES) throw new SnapshotMetadataTooLarge(key, bytes)
    const value = encodeSnapshotValue({ source: entry.source, signingKey: entry.signingKey }, entry.car)
    // No expirationTtl, deliberately: an unchanged record must stay served
    // indefinitely.
    await env.records.put(key, value, { metadata })
}

/** Singleton key — one marker for the whole digest, not one per window.
 * Exported so a test can reset it directly: `env.records` is shared across
 * tests in this package's suite (KV, unlike Durable Object storage, is not
 * reset per test), and this is the one entry with no per-test-unique key
 * to naturally avoid collision the way record and window keys do. */
export const DIGEST_MARKER_KEY = "digest:marker"

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
            env.records.getWithMetadata<unknown>(RECORD_PREFIX + did, "arrayBuffer"),
            env.records.get<SnapshotCheck>(CHECK_PREFIX + did, "json"),
        ])
        const entry = decodeEntry(value, metadata, RECORD_PREFIX + did)
        if (entry === null) return null
        const confirmedAtMs =
            check !== null && check.rev === entry.meta.rev ? check.checkedAtMs : 0
        return {
            car: entry.car,
            freshAtMs: Math.max(entry.meta.observedAtMs, confirmedAtMs),
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
                env.records.getWithMetadata<unknown>(keys.record, "arrayBuffer"),
                env.records.get<SnapshotCheck>(keys.check, "json"),
            ])
            const entry = decodeEntry(value, metadata, keys.record)
            if (entry === null) return null
            const { meta } = entry
            const verifiedWith = meta.verifiedWith
            const confirmedAtMs =
                check !== null && check.rev === meta.rev ? check.checkedAtMs : 0
            return {
                car: entry.car,
                freshAtMs: Math.max(meta.observedAtMs, confirmedAtMs),
                verifiedWith,
                // An entry stored before ingest verified carries an unsigned rev.
                rev: verifiedWith === null ? null : meta.rev,
                cid: verifiedWith === null ? null : meta.cid,
                commitCid: verifiedWith === null ? null : meta.commitCid,
                evidence: storedEvidence({ did, collection, rkey }, meta),
                ...(meta.policies ? { policies: meta.policies } : {}),
            }
        },
    }
}

/**
 * The index metadata of the bulk-read `keys` that hold a v2 entry. Entries
 * that are not v2 are logged once per call with a count, not per key.
 */
async function readBulkMeta(
    env: { records: KVNamespace },
    keys: readonly string[]
): Promise<Map<string, SnapshotIndexMeta>> {
    const out = new Map<string, SnapshotIndexMeta>()
    let notV2 = 0
    for (let i = 0; i < keys.length; i += KV_BULK_READ_MAX) {
        const rows = await env.records.getWithMetadata<unknown>(keys.slice(i, i + KV_BULK_READ_MAX), "text")
        for (const [key, row] of rows) {
            if (row === null || row.value === null) continue
            const meta = readIndexMeta(row.metadata)
            if (meta === null) notV2 += 1
            else out.set(key, meta)
        }
    }
    if (notV2 > 0) console.warn("monitor: snapshot entries not v2", { count: notV2 })
    return out
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
            const records = await readBulkMeta(
                env,
                keys.map((k) => k.record)
            )
            const checks = new Map<string, SnapshotCheck | null>()
            for (let i = 0; i < keys.length; i += KV_BULK_READ_MAX) {
                const chks = await env.records.get<SnapshotCheck>(
                    keys.slice(i, i + KV_BULK_READ_MAX).map((k) => k.check),
                    "json"
                )
                for (const [key, check] of chks) checks.set(key, check)
            }
            return refs.map((ref, i) => {
                const metadata = records.get(keys[i]!.record)
                if (!metadata) return null
                const { verifiedWith, cid } = metadata
                if (verifiedWith === null || cid === null) return null
                const check = checks.get(keys[i]!.check) ?? null
                const confirmedAtMs = check !== null && check.rev === metadata.rev ? check.checkedAtMs : 0
                return {
                    ...ref,
                    cid,
                    verifiedWith,
                    commitCid: metadata.commitCid,
                    rev: metadata.rev,
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
    const keys = distinct.map((did) => snapshotKeys(did, DECLARATION_COLLECTION_NSID, "self").record)
    const metas = await readBulkMeta(env, keys)
    const out = new Map<string, number | null>()
    distinct.forEach((did, i) => out.set(did, metas.get(keys[i]!)?.messagingKeyFirstSeenAtMs ?? null))
    return out
}

/** A held declaration as the relay's declared-key index needs it. */
export interface DeclaredKeyRecord {
    did: string
    rev: string
    cid: string
    verifiedWith: string
    car: Uint8Array
}

/**
 * The verified declarations the store holds, a page of at most `limit` at a
 * time, for an index built over the declared keys. Entries that are not v2 or
 * not verified are skipped.
 */
export async function kvDeclaredKeyPage<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>,
    page: { cursor?: string; limit?: number } = {}
): Promise<{ records: DeclaredKeyRecord[]; cursor: string | null }> {
    const listed = await env.records.list({
        prefix: `${RECORD_PREFIX}did:`,
        limit: page.limit ?? 100,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    })
    const records: DeclaredKeyRecord[] = []
    let notV2 = 0
    const rows = await Promise.all(
        listed.keys.map(async ({ name }) => ({
            name,
            ...(await env.records.getWithMetadata<unknown>(name, "arrayBuffer")),
        }))
    )
    for (const { name, value, metadata } of rows) {
        if (value === null || metadata === null) continue
        const meta = readIndexMeta(metadata)
        const decoded = meta === null ? null : decodeSnapshotValue(new Uint8Array(value))
        if (meta === null || decoded === null) {
            notV2 += 1
            continue
        }
        if (meta.verifiedWith === null || meta.cid === null) continue
        records.push({
            did: name.slice(RECORD_PREFIX.length),
            rev: meta.rev,
            cid: meta.cid,
            verifiedWith: meta.verifiedWith,
            car: decoded.car,
        })
    }
    if (notV2 > 0) console.warn("monitor: snapshot entries not v2", { count: notV2 })
    return { records, cursor: listed.list_complete ? null : listed.cursor }
}

/** Keys one KV bulk read accepts. */
const KV_BULK_READ_MAX = 100
