/**
 * The follow/profile stream: one Jetstream socket filtered on the follow
 * collection and the secondaries' collections, with no `dids` filter, so its
 * URL never changes with the allow list. Every event is routed by index
 * lookups alone, in the read loop, and whatever it keeps is written in the
 * same step as the stream's own cursor.
 */
import type { WatchedRecord } from "@germ-network/atproto-pmr-core"
import type { MonitorEvent } from "./jetstream"
import { intakeSecondary } from "./secondary"
import type { Cursor, InterestIndex, SecondaryIntakeIndex } from "./storage"

import { BLOCK_COLLECTION_NSID, FOLLOW_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"

export { BLOCK_COLLECTION_NSID, FOLLOW_COLLECTION_NSID }

/** Which edge collection a logged op or staged listing row belongs to. */
export type EdgeCollection = "follow" | "block"

/**
 * The single writer's log of live follow changes, flushed to the edge index
 * in `seq` order. `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so a seq is
 * never reused once the flush empties the table, and a listing's
 * `started_seq` stays below every later op. A resume rewind re-logs a
 * replayed suffix; the edge writes it feeds are idempotent.
 */
export const EDGE_OPS_TABLE = "edge_ops"

/**
 * One live follow change, as logged. A delete carries no subject: the stream
 * does not say whom the deleted record followed, so it applies by
 * `(follower, rkey)`.
 */
export type EdgeOp =
    | {
          seq: number
          kind: "create"
          follower: string
          rkey: string
          subject: string
          /** The commit's rev, so a listing at a signed rev can tell older ops from newer. */
          rev: string
          cursor: Cursor
      }
    | {
          seq: number
          kind: "delete"
          follower: string
          rkey: string
          rev: string
          cursor: Cursor
      }

/** An op before the log assigns its `seq`. */
export type NewEdgeOp = EdgeOp extends infer T ? (T extends unknown ? Omit<T, "seq"> : never) : never

export interface FollowStreamIndex {
    readFollowCursor(): Promise<Cursor | null>
    /**
     * An event nothing kept: the cursor advances, and is persisted at most
     * once per `FOLLOW_CURSOR_PERSIST_MS`.
     */
    skipFollowEvent(cursor: Cursor): Promise<void>
    /** Log a follow change and persist the cursor, atomically. */
    logEdgeOp(op: NewEdgeOp, cursor: Cursor): Promise<void>
    /** Queue `did`'s follow listing to run again, and persist the cursor, atomically. */
    requeueListing(did: string, cursor: Cursor): Promise<void>
}

export interface FollowRouteDeps {
    index: FollowStreamIndex &
        SecondaryIntakeIndex &
        Pick<InterestIndex, "inInterest" | "isRegistered" | "isGraphOwner">
    secondaries: readonly WatchedRecord[]
}

export type FollowRoute =
    | "edge-op"
    /** A secondary commit owed a fetch. */
    | "owed"
    /** A secondary commit at the rev already indexed. */
    | "duplicate"
    | "relist"
    | "dropped"

/**
 * Route one decoded event:
 * - a follow create by a graph owner, or of a registered DID by a follower in
 *   interest, and a follow delete by a follower in interest: logged; an
 *   update with a subject is routed as a create (it replaces the edge of
 *   `(follower, rkey)`), a create or update without one is dropped;
 * - a secondary commit for a DID in interest: owed, unless at the indexed rev;
 * - `#sync`, or `#account` turning active, for a DID in interest: its
 *   listing re-queued;
 * - anything else, identity events included: dropped.
 */
export async function routeFollowEvent(
    deps: FollowRouteDeps,
    event: MonitorEvent,
    cursor: Cursor
): Promise<FollowRoute> {
    const { index } = deps
    const skip = async (route: "dropped" | "duplicate"): Promise<FollowRoute> => {
        await index.skipFollowEvent(cursor)
        return route
    }

    if (event.kind !== "commit") {
        if (event.kind === "identity") return skip("dropped")
        if (event.kind === "account" && event.active !== true) return skip("dropped")
        if (!(await index.inInterest(event.did))) return skip("dropped")
        await index.requeueListing(event.did, cursor)
        return "relist"
    }

    if (event.collection === FOLLOW_COLLECTION_NSID) {
        const follower = event.did
        if (event.operation === "delete") {
            if (!(await index.inInterest(follower))) return skip("dropped")
            await index.logEdgeOp(
                { kind: "delete", follower, rkey: event.rkey, rev: event.rev, cursor },
                cursor
            )
            return "edge-op"
        }
        const subject = event.subject
        if (subject === null) return skip("dropped")
        const kept =
            (await index.isGraphOwner(follower)) ||
            ((await index.inInterest(follower)) && (await index.isRegistered(subject)))
        if (!kept) return skip("dropped")
        await index.logEdgeOp(
            { kind: "create", follower, rkey: event.rkey, subject, rev: event.rev, cursor },
            cursor
        )
        return "edge-op"
    }

    const decision = await intakeSecondary(
        { index },
        { records: deps.secondaries },
        event,
        cursor
    )
    if (decision === "accepted") return "owed"
    return skip(decision === "duplicate" ? "duplicate" : "dropped")
}
