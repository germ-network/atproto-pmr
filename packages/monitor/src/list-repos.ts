/**
 * Tier 3: enumeration for the baseline build.
 *
 * `com.atproto.sync.listReposByCollection` at a relay — every DID
 * currently carrying the collection, paginated. An enumeration hint only:
 * nothing here enters the snapshot, and every DID it names still goes
 * through the ordinary tier-2 fetch-and-verify before anything is stored
 * (`docs/monitor-ingest.md`, "Reconciliation").
 */

import { guardedFetchJSON } from "@germ-network/atproto-pmr-core"

export interface ListReposPage {
    dids: string[]
    /** `null` once the relay's list is exhausted. */
    nextCursor: string | null
}

export interface ListReposOptions {
    /** The relay to enumerate against, e.g. `https://relay1.us-west.bsky.network`. */
    relayUrl: string
    collection: string
    limit?: number
    fetchImpl?: typeof fetch
}

export async function listReposByCollection(
    cursor: string | null,
    options: ListReposOptions
): Promise<ListReposPage> {
    const fetchImpl = options.fetchImpl ?? fetch
    const url = new URL(`${options.relayUrl}/xrpc/com.atproto.sync.listReposByCollection`)
    url.searchParams.set("collection", options.collection)
    url.searchParams.set("limit", String(options.limit ?? 100))
    if (cursor !== null) url.searchParams.set("cursor", cursor)

    const body = (await guardedFetchJSON(url.toString(), fetchImpl)) as {
        repos?: unknown
        cursor?: unknown
    }
    if (!Array.isArray(body.repos)) {
        throw new Error("listReposByCollection: malformed response")
    }

    const dids: string[] = []
    for (const entry of body.repos) {
        if (typeof entry !== "object" || entry === null) continue
        const did = (entry as { did?: unknown }).did
        if (typeof did === "string") dids.push(did)
    }

    return {
        dids,
        // An empty cursor means the same thing as an absent one — the
        // relay is telling us we reached the end, not handing back a page
        // boundary to resume from.
        nextCursor: typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : null,
    }
}
