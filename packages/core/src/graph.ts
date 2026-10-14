/**
 * What a monitor's graph index tells its consumers: an ordered log of whose
 * graph changed, and which DIDs the monitor serves.
 */

/**
 * Why a DID's projection is stale. `following`: its own outgoing edges
 * changed. `followers`: an edge to it changed. `holder-add`/`holder-remove`:
 * it gained or lost its declaration. `served-add`/`served-remove`: its graph
 * started or stopped being served.
 */
export type GraphChangeReason =
    | "following"
    | "followers"
    | "holder-add"
    | "holder-remove"
    | "served-add"
    | "served-remove"

export interface GraphChangeRow {
    seq: number
    did: string
    reason: GraphChangeReason
    atMs: number
}

/**
 * At-least-once and in `seq` order; one DID may appear many times. Rows age
 * out, so a consumer whose cursor falls behind the oldest row rebuilds.
 */
export interface GraphChangeLog {
    /** `maxSeq` is read with the rows, so "rebuilt as of seq N" cannot race the writer. */
    readSince(seq: number, limit: number): Promise<{ rows: GraphChangeRow[]; maxSeq: number }>
}

/** The monitor's allow list, as a read route sees it. */
export interface InterestReader {
    /** Whether the monitor serves records for this DID. */
    serves(did: string): Promise<boolean>
    isRegistered(did: string): Promise<boolean>
    /** The DIDs whose graphs are served, paged; `cursor` is null after the last page. */
    servedGraphs(
        cursor: string | null,
        limit: number
    ): Promise<{ dids: string[]; cursor: string | null }>
}
