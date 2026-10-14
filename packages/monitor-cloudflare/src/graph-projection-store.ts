import {
    decodeGraphReadResponse,
    encodeGraphReadResponse,
    type GraphProjectionWriter,
    type GraphReadResponse,
} from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "./env"

const GRAPH_PREFIX = "graph:"

/**
 * The public graph projections in the `records` namespace, one
 * `graph:<did>` entry per served graph, written only by the projector and
 * stored as the CBOR body the read route serves. No expiry: a projection
 * stays until the projector replaces or deletes it.
 */
export function kvGraphProjections(env: MonitorEnv): GraphProjectionWriter {
    return {
        async get(did: string): Promise<GraphReadResponse | null> {
            const value = await env.records.get(GRAPH_PREFIX + did, "arrayBuffer")
            return value === null ? null : decodeGraphReadResponse(new Uint8Array(value))
        },

        async put(projection: GraphReadResponse): Promise<void> {
            await env.records.put(
                GRAPH_PREFIX + projection.did,
                encodeGraphReadResponse(projection)
            )
        },

        async delete(did: string): Promise<void> {
            await env.records.delete(GRAPH_PREFIX + did)
        },
    }
}
