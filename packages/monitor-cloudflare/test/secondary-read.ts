import type { RecordRef } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { kvRecordSnapshots } from "../src/snapshot-store"

/** What a public reader sees for a secondary: the writer itself never reads one back. */
export function readSecondary(env: MonitorEnv, ref: RecordRef) {
    return kvRecordSnapshots(env).get(ref.did, ref.collection, ref.rkey)
}
