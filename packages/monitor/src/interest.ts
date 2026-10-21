/**
 * Acting on the allow list's joins and leaves. A join owes the declaration
 * and every secondary, quietly: being newly watched is not a change anyone
 * holds. A leave disposes of everything kept for the DID, with no push (it
 * is no longer watched, not deleted), and withdraws its stored DID document,
 * since nothing will keep that current any more.
 */
import type { WatchedRecord } from "@germ-network/atproto-pmr-core"
import type { IngestDeps } from "./ingest"
import type {
    DidDocumentSink,
    InterestIndex,
    MonitorIndex,
    SecondarySnapshotStore,
    SnapshotStore,
} from "./storage"

export interface InterestDeps {
    interest: InterestIndex
    index: Pick<MonitorIndex, "recordsOf">
    snapshot: SnapshotStore & SecondarySnapshotStore
    secondaries: readonly WatchedRecord[]
    didDocuments?: DidDocumentSink
    nowMs(): number
    /** Raised with `null` once a leave has disposed of the DID; see `IngestDeps.onSettled`. */
    onSettled?: IngestDeps["onSettled"]
}

/**
 * Apply up to `limit` queued transitions, oldest first; returns how many
 * applied. A transition whose KV work fails stays queued for the next tick.
 *
 * A leave deletes the bytes first and then the index rows, the order every
 * write keeps (KV, then index), and withdraws the stored DID document since
 * nothing will keep it current. A transition for an epoch the DID has moved
 * past is dropped: the newer one is queued in its place.
 */
export async function applyInterestTransitions(
    deps: InterestDeps,
    limit: number
): Promise<number> {
    const due = await deps.interest.dueTransitions(limit)
    let applied = 0
    for (const t of due) {
        try {
            if ((await deps.interest.interestEpoch(t.did)) !== t.epoch) {
                await deps.interest.clearTransition(t.did, t.epoch)
                continue
            }
            if (t.change === "join") {
                await deps.interest.oweJoin(t.did, deps.secondaries, t.epoch)
            } else {
                await dispose(deps, t.did)
            }
            await deps.interest.clearTransition(t.did, t.epoch)
            applied += 1
        } catch {
            // Retried by the next tick.
        }
    }
    return applied
}

async function dispose(deps: InterestDeps, did: string): Promise<void> {
    const refs = new Map<string, { collection: string; rkey: string }>()
    for (const r of await deps.index.recordsOf(did)) {
        refs.set(`${r.collection}/${r.rkey}`, r)
    }
    for (const r of deps.secondaries) refs.set(`${r.collection}/${r.rkey}`, r)
    await deps.snapshot.deleteRecord(did)
    for (const r of refs.values()) {
        await deps.snapshot.deleteSecondary({ did, collection: r.collection, rkey: r.rkey })
    }
    await deps.didDocuments?.markDidDocumentStale(did, deps.nowMs())
    await deps.interest.forgetLeft(did)
    try {
        await deps.onSettled?.(did, null)
    } catch {}
}
