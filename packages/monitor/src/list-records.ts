/**
 * `com.atproto.repo.listRecords` for the follow or block collection, at the
 * DID's own PDS: the source of the mutual and paged owner listings. Unverified (the
 * response carries no proof), so what it yields are hints only.
 */
import { guardedFetchJSON } from "@germ-network/atproto-pmr-core"
import type { FollowPage, FollowRecord } from "./follow-backfill"
import type { EdgeCollection } from "./follow-stream"
import { BLOCK_COLLECTION_NSID, FOLLOW_COLLECTION_NSID } from "./follow-stream"

export interface ListEdgeRecordsOptions {
    /** The PDS the DID's document names, resolved once per listing by the caller. */
    pds: string
    /** Records per page, default 100. */
    limit?: number
    fetchImpl?: typeof fetch
}

const TERMINAL_ERRORS = ["RepoNotFound", "RepoTakendown", "RepoSuspended", "RepoDeactivated"]
const PERMANENT_ERRORS = ["RepoNotFound"]

/**
 * One page of `did`'s records of `collection` in ascending rkey order (`reverse=true`; the
 * endpoint's default is descending), after rkey `cursor` (null for the first
 * page). A record whose `subject` is not a string is skipped but still moves
 * `lastRkey`, so a page of only malformed records does not end the listing.
 * A raw empty page is the end; a missing response cursor is not.
 */
export async function listEdgeRecords(
    did: string,
    collection: EdgeCollection,
    cursor: string | null,
    options: ListEdgeRecordsOptions
): Promise<FollowPage> {
    const url = new URL(`${options.pds}/xrpc/com.atproto.repo.listRecords`)
    url.searchParams.set("repo", did)
    url.searchParams.set(
        "collection",
        collection === "follow" ? FOLLOW_COLLECTION_NSID : BLOCK_COLLECTION_NSID
    )
    url.searchParams.set("limit", String(options.limit ?? 100))
    url.searchParams.set("reverse", "true")
    if (cursor !== null) url.searchParams.set("cursor", cursor)

    const body = await guardedFetchJSON(url.toString(), options.fetchImpl ?? fetch, {
        terminalErrorNames: TERMINAL_ERRORS,
        permanentErrorNames: PERMANENT_ERRORS,
    })
    const raw = (body as { records?: unknown } | null)?.records
    if (!Array.isArray(raw)) throw new Error("listRecords answered without records")

    const records: FollowRecord[] = []
    let lastRkey: string | null = null
    for (const entry of raw as { uri?: unknown; value?: { subject?: unknown } }[]) {
        if (typeof entry?.uri !== "string") continue
        const rkey = entry.uri.slice(entry.uri.lastIndexOf("/") + 1)
        lastRkey = rkey
        const subject = entry.value?.subject
        if (typeof subject === "string") records.push({ rkey, subject })
    }
    return { records, lastRkey }
}
