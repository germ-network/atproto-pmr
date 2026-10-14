import {
    DECLARATION_COLLECTION_NSID,
    type RecordSnapshotStore,
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

/**
 * The serving half of the seam, on KV.
 *
 * KV rather than Durable Object storage because the read paths are public,
 * cacheable, and want to run in plain Workers near the caller — the
 * community view should scale like the public data it is, not funnel
 * through one object in one location. **No request handler reaches the
 * ingest object at all** — every read here, including the digest marker,
 * is this store or nothing, which is what keeps a read from ever sharing
 * fate with a wedged, evicted, or reconnecting writer.
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

/** Singleton key — one marker for the whole digest, not one per window.
 * Exported so a test can reset it directly: `env.records` is shared across
 * tests in this package's suite (KV, unlike Durable Object storage, is not
 * reset per test), and this is the one entry with no per-test-unique key
 * to naturally avoid collision the way record and window keys do. */
export const DIGEST_MARKER_KEY = "digest:marker"

/** Stored beside the bytes so a reader knows what it holds without the index. */
interface StoredMeta {
    rev: string
    observedAtMs: number
    source: string
    signingKey: string | null
    verifiedWith: string | null
    cid: string | null
    seenKey: string | null
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
        async getRecord(did: string): Promise<SnapshotEntry | null> {
            const { value, metadata } = await env.records.getWithMetadata<StoredMeta>(
                RECORD_PREFIX + did,
                "arrayBuffer"
            )
            if (value === null || metadata === null) return null
            return {
                rev: metadata.rev,
                car: new Uint8Array(value),
                observedAtMs: metadata.observedAtMs,
                source: metadata.source,
                signingKey: metadata.signingKey,
                verifiedWith: metadata.verifiedWith ?? null,
                cid: metadata.cid ?? null,
                seenKey: metadata.seenKey ?? null,
            }
        },

        async putRecord(did: string, entry: SnapshotEntry): Promise<void> {
            // No expirationTtl, deliberately: an unchanged record must stay
            // served indefinitely.
            await env.records.put(RECORD_PREFIX + did, entry.car, {
                metadata: {
                    rev: entry.rev,
                    observedAtMs: entry.observedAtMs,
                    source: entry.source,
                    signingKey: entry.signingKey,
                    verifiedWith: entry.verifiedWith,
                    cid: entry.cid,
                    seenKey: entry.seenKey ?? null,
                } satisfies StoredMeta,
            })
        },

        async deleteRecord(did: string): Promise<void> {
            await env.records.delete(RECORD_PREFIX + did)
            // A confirmation of a CAR that no longer exists must not outlive it.
            await env.records.delete(CHECK_PREFIX + did)
        },

        async putCheck(did: string, check: SnapshotCheck): Promise<void> {
            await env.records.put(CHECK_PREFIX + did, JSON.stringify(check))
        },

        async getSecondary(_ref: RecordRef): Promise<SnapshotEntry | null> {
            throw new Error("not implemented")
        },

        async putSecondary(_ref: RecordRef, _entry: SnapshotEntry): Promise<void> {
            throw new Error("not implemented")
        },

        async deleteSecondary(_ref: RecordRef): Promise<void> {
            throw new Error("not implemented")
        },

        async putSecondaryCheck(_ref: RecordRef, _check: SnapshotCheck): Promise<void> {
            throw new Error("not implemented")
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
    _env: MonitorEnv<TIngest>
): RecordSnapshotStore {
    return {
        async get() {
            throw new Error("not implemented")
        },
    }
}
