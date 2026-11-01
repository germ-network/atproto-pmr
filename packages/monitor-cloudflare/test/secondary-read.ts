import type { RecordRef } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import {
    encodeSnapshotValue,
    SNAPSHOT_FORMAT_VERSION,
    type SnapshotDetail,
    type SnapshotIndexMeta,
} from "../src/snapshot-layout"
import { kvRecordSnapshots } from "../src/snapshot-store"

/** What a public reader sees for a secondary: the writer itself never reads one back. */
export function readSecondary(env: MonitorEnv, ref: RecordRef) {
    return kvRecordSnapshots(env).get(ref.did, ref.collection, ref.rkey)
}

/** Writes a v2 entry as the store would, with `meta` overriding the defaults. */
export async function putV2Entry(
    env: MonitorEnv,
    key: string,
    meta: Partial<SnapshotIndexMeta> = {},
    car: Uint8Array = new Uint8Array([1]),
    detail: SnapshotDetail = { source: "s", signingKey: null }
): Promise<void> {
    await env.records.put(key, encodeSnapshotValue(detail, car), {
        metadata: { v: SNAPSHOT_FORMAT_VERSION, rev: "3k", cid: null, commitCid: null, verifiedWith: null, observedAtMs: 1, ...meta },
    })
}
