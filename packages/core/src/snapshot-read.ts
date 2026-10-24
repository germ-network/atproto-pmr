/**
 * A verified read of one record from a third party's stored snapshot, generic
 * over collection and rkey. Pair-put admission reaches it through
 * `snapshotDeclarationResolver`; a device-facing read would call it directly.
 */
import { RecordNotFoundError, SIGNING_KEY_TTL_MS } from "./atproto-fetch"
import type { StoredPolicies } from "./policy"
import { readRecordFromCar, verifyRecordProof, type VerifiedRecord } from "./repo-proof"
import type { SnapshotEvidence } from "./summary-evidence-contract"

/** A third party's stored proof of one record. */
export interface RecordSnapshot {
    /** The single-record proof CAR (`com.atproto.sync.getRecord`). */
    car: Uint8Array
    /** When the holder last confirmed this CAR is still the repo's current view. */
    freshAtMs: number
}

/**
 * The snapshots a monitor holds, addressed by record. How a record maps to a
 * storage key is the adapter's: the declaration keeps the key it has always
 * had, so adding a collection needs no migration of existing snapshots.
 */
export interface RecordSnapshotStore {
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    get(did: string, collection: string, rkey: string): Promise<StoredRecordSnapshot | null>
}

/**
 * A held snapshot with the ingest's verdict on it. A public read serves held
 * bytes without verifying them per read, so whether they verified is decided
 * once, when they were stored.
 */
export interface StoredRecordSnapshot extends RecordSnapshot {
    /**
     * The `#atproto` multikey the CAR's commit signature verified against at
     * ingest. Null for an entry stored without that record, which reads as
     * unverifiable. A key the DID document no longer carries makes the
     * verdict stale.
     */
    verifiedWith: string | null
    /** The signed commit's `rev`, as verified at ingest. Null for an entry stored without it. */
    rev: string | null
    /** The record's CID (`bafyrei…`), as verified at ingest. Null for an entry stored without it. */
    cid: string | null
    /** Exact signed commit CID, absent on legacy entries. */
    commitCid?: string | null
    /** First-observation history stored atomically beside the CAR. */
    evidence?: SnapshotEvidence | null
    /**
     * A declaration's policies, decoded once when it was stored. Absent for
     * any other record and for a declaration stored before policies were
     * kept, and for one ingest did not verify; a reader then falls back to
     * parsing `car`.
     */
    policies?: StoredPolicies
}

/**
 * A snapshot not confirmed for this long is checked directly against the
 * DID's PDS to see whether the record has changed. Generous on purpose: the
 * monitor's refresh keeps snapshots far fresher than this in normal
 * operation, so reaching it means the monitor has fallen behind.
 */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type SnapshotRecordRead =
    | {
          found: true
          /** The record block, decoded as DAG-CBOR. */
          record: unknown
          /** The record's CID (CIDv1, dag-cbor, sha2-256, base32 lower). */
          cid: string
          /** The signed commit's `rev`. */
          rev: string
          /** The verified snapshot CAR, byte for byte. */
          car: Uint8Array
      }
    | { found: false; reason: string }

export interface SnapshotRecordReaderDeps {
    collection: string
    rkey: string
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    getSnapshot: (did: string) => Promise<RecordSnapshot | null>
    /** The DID document's `#atproto` multikey, or null. Never contacts the PDS. */
    resolveSigningKey: (did: string) => Promise<string | null>
    nowMs: () => number
    /**
     * Reads the proof CAR for `collection`/`rkey` straight from the DID's PDS,
     * used only for a snapshot older than `SNAPSHOT_MAX_AGE_MS`, and only to
     * compare: the PDS is not trusted for the value. If its record CID equals
     * the snapshot's, the snapshot stands; if it differs or the record is
     * gone, the snapshot is out of date and the record is not found until the
     * snapshot holder catches up. A failed read falls back to the older
     * snapshot. A definite answer is remembered for `SIGNING_KEY_TTL_MS`, so
     * repeated reads of a lapsed DID do not each cost a PDS read.
     */
    fetchDirect: (did: string, collection: string, rkey: string) => Promise<Uint8Array>
}

const DIRECT_VERDICTS_MAX = 1024

/**
 * Reads `collection`/`rkey` for a DID from its third-party snapshot, verified
 * against the DID document's signing key. A miss is never fetched inline: that
 * would tell the PDS when the DID is being read. Only a held snapshot that has
 * gone unconfirmed past `SNAPSHOT_MAX_AGE_MS` triggers a direct read, to see
 * whether it is still the current record.
 *
 * Construct one reader and reuse it: the memo of direct-read answers lives in
 * the instance.
 */
export function snapshotRecordReader(
    deps: SnapshotRecordReaderDeps
): (did: string) => Promise<SnapshotRecordRead> {
    // Per isolate, bounded: repeated or forged reads naming a lapsed DID must
    // not become a read of its PDS each time.
    const verdicts = new Map<string, { cid: string | null; atMs: number }>()
    return async (did) => {
        const snapshot = await deps.getSnapshot(did)
        if (!snapshot) return { found: false, reason: "no snapshot held" }
        const signingKey = await deps.resolveSigningKey(did)
        if (!signingKey) return { found: false, reason: "no signing key" }

        let verified: VerifiedRecord
        try {
            verified = verifyRecordProof(snapshot.car, {
                did,
                signingKey,
                collection: deps.collection,
                rkey: deps.rkey,
            })
        } catch (error) {
            return { found: false, reason: `snapshot did not verify: ${String(error)}` }
        }

        const now = deps.nowMs()
        if (!(now - snapshot.freshAtMs <= SNAPSHOT_MAX_AGE_MS)) {
            let current: string | null | undefined
            const remembered = verdicts.get(did)
            if (remembered !== undefined && now - remembered.atMs < SIGNING_KEY_TTL_MS) {
                current = remembered.cid
            } else {
                try {
                    // Not verified: only its record CID is compared, and block
                    // hashes are still checked while reading it.
                    current =
                        readRecordFromCar(
                            await deps.fetchDirect(did, deps.collection, deps.rkey),
                            deps.collection,
                            deps.rkey
                        )?.cid ?? null
                } catch (error) {
                    // Gone at the source is an answer; anything else
                    // (unreachable, malformed) says nothing about the snapshot.
                    current = error instanceof RecordNotFoundError ? null : undefined
                }
                if (current !== undefined) {
                    if (verdicts.size >= DIRECT_VERDICTS_MAX) {
                        verdicts.delete(verdicts.keys().next().value!)
                    }
                    verdicts.set(did, { cid: current, atMs: now })
                }
            }
            if (current !== undefined && current !== verified.cid) {
                return { found: false, reason: "snapshot is out of date" }
            }
        }

        return {
            found: true,
            record: verified.record,
            cid: verified.cid,
            rev: verified.rev,
            car: snapshot.car,
        }
    }
}
