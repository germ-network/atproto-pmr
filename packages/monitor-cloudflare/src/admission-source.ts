import type { AdmissionSource, SnapshotPolicySourceDeps } from "@germ-network/atproto-pmr-core"

/**
 * Receive-time admission for a relay Worker bound to the monitor's D1 and
 * records KV: the can-message verdict for (sender, hosted recipient), read
 * without reaching the monitor's ingest object, so a flood of pair puts
 * never slows ingest. Graph reads go through a D1 session that may be served
 * by a replica. The recipient's policies come from its snapshot with no
 * re-check of a stale one, which would call the ingest object on every put.
 */
export function d1AdmissionSource(deps: {
    db: D1Database
    snapshots: Omit<SnapshotPolicySourceDeps, "recheck">
}): AdmissionSource {
    throw new Error("not implemented")
}
