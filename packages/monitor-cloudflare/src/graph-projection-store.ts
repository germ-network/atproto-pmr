import type { GraphProjectionWriter } from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "./env"

/**
 * The public graph projections in the `records` namespace, one
 * `graph:<did>` entry per declaration holder, written only by the projector.
 */
export function kvGraphProjections(env: MonitorEnv): GraphProjectionWriter {
    throw new Error("not implemented")
}
