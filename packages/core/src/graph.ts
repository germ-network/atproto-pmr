/**
 * What a monitor's graph index tells its consumers: which DIDs the monitor
 * serves.
 */

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
