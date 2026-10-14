/**
 * Acting on the allow list's joins and leaves. A join owes the declaration
 * and every secondary, quietly: being newly watched is not a change anyone
 * holds. A leave disposes of everything kept for the DID, with no push (it
 * is no longer watched, not deleted), and withdraws its stored DID document,
 * since nothing will keep that current any more.
 */
import type { WatchedRecord } from "@germ-network/atproto-pmr-core"
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
}

/** Apply up to `limit` queued transitions, oldest first; returns how many applied. */
export async function applyInterestTransitions(
    _deps: InterestDeps,
    _limit: number
): Promise<number> {
    throw new Error("not implemented")
}
