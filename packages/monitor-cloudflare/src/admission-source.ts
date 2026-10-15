import {
    admissionOf,
    computeCanMessage,
    snapshotPolicySource,
    type AdmissionSource,
    type SnapshotPolicySourceDeps,
} from "@germ-network/atproto-pmr-core"
import { d1SenderGraphReader } from "./sender-graph-reader"

/**
 * Receive-time admission for a relay Worker bound to the monitor's D1 and
 * records KV: the can-message verdict for (sender, hosted recipient), read
 * without reaching the monitor's ingest object, so a flood of pair puts
 * never slows ingest. It reaches no PDS as long as `snapshots.readDeclaration`
 * is built without a direct fetch. Graph reads go through a D1 session that
 * may be served by a replica. The recipient's policies come from its snapshot with no
 * re-check of a stale one, which would call the ingest object on every put.
 */
export function d1AdmissionSource(deps: {
    db: D1Database
    snapshots: Omit<SnapshotPolicySourceDeps, "recheck">
}): AdmissionSource {
    // Stripped at runtime too: a caller that casts a recheck in must not reach the ingest object.
    const { recheck: _recheck, ...snapshots } = deps.snapshots as SnapshotPolicySourceDeps
    const policies = snapshotPolicySource(snapshots)
    return {
        async admission(sender, recipient) {
            // One session per read: its bookmark must not be shared across requests.
            const graph = d1SenderGraphReader(deps.db.withSession("first-unconstrained"))
            return admissionOf(await computeCanMessage(sender, recipient, { policies, graph }))
        },
    }
}
