import type { CanMessageVerdict } from "./can-message.js"
import type { OwnerGraph, OwnerGraphEdge } from "./owner-graph.js"
import type { SummaryVerdict } from "./summary-verdicts.js"

/**
 * GER-3095 source/client contract for the backend aggregate.
 */

/** Absolute Unix epoch milliseconds; null when a complete aggregate is unavailable. */
export type PermissionRecencyAtMs = number | null

/** Short CBOR key in both can-message and summary verdict maps. */
export const PERMISSION_RECENCY_CBOR_KEY = "t" as const

/** Internal inputs to the aggregate. They are not part of the public wire value. */
export interface PermissionRecencyInputs {
    messagingKeyFirstSeenAtMs: number | null
    aFollowedBAtMs: number | null
    bFollowedAAtMs: number | null
}
/** One public A-can-message-B result, extending the actual current verdict union. */
export type CanMessageRecencyResult = CanMessageVerdict & {
    permissionRecencyAtMs: PermissionRecencyAtMs
}

/** The same aggregate is carried on the actual held per-contact summary row. */
export type HeldSummaryRecencyVerdict = SummaryVerdict & {
    permissionRecencyAtMs: PermissionRecencyAtMs
}

/**
 * Private graph seam. Preserve directional timestamp hints before
 * ownerGraph() deduplicates multiple active rkeys to one contact edge.
 */
export type OwnerGraphRecencyEdge = OwnerGraphEdge & {
    ownerFollowsContactAtMs: PermissionRecencyAtMs
    contactFollowsOwnerAtMs: PermissionRecencyAtMs
}

/** Owner graph with the private directional hints retained through deduplication. */
export type OwnerGraphWithRecency = Omit<OwnerGraph, "following" | "followers"> & {
    following: OwnerGraphRecencyEdge[]
    followers: OwnerGraphRecencyEdge[]
}

/** Server-only token baseline marker; kept separate from evidenceSchema. */
export interface HeldOwnerRecencySummary {
    permissionRecencySchema: 1
    verdicts: HeldSummaryRecencyVerdict[]
}

/**
 * A complete aggregate is the latest of the three accepted inputs. Returning
 * null for a partial tuple avoids claiming a maximum when an unknown input
 * could be later. Callers use null as unknown/unranked and retain the contact.
 */
export function permissionRecencyAtMs(inputs: PermissionRecencyInputs): PermissionRecencyAtMs {
    const values = [
        inputs.messagingKeyFirstSeenAtMs,
        inputs.aFollowedBAtMs,
        inputs.bFollowedAAtMs,
    ]
    const valid = values.filter(
        (value): value is number => value !== null && Number.isSafeInteger(value) && value >= 0
    )
    return valid.length === values.length ? Math.max(...valid) : null
}

