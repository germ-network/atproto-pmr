/**
 * What a monitor watches. A `WatchedRecord` is a singleton record snapshotted
 * for every watched DID; a `WatchedCollection` is a whole collection, such as
 * follows, whose events are kept only for DIDs in the monitor's interest set.
 * The interest set is the monitor's allow list, chosen by its
 * `InterestPolicy`; the subscription itself is filtered by collection only.
 */

import { BLOCK_COLLECTION_NSID } from "./block-edges"
import { DECLARATION_COLLECTION_NSID } from "./declaration"
import { FOLLOW_COLLECTION_NSID } from "./follow-edges"

export interface WatchedRecord {
    collection: string
    rkey: string
}

/** The DIDs a collection is kept for: the monitor's interest set. */
export type WatchedDidSet = "interest"

/**
 * Who a monitor watches. `registered`: its registered users and every DID
 * they follow, so a self-hosted or multi-tenant relay pays per user.
 * `everyone`: every DID carrying a Germ declaration, and every one of their
 * social graphs.
 */
export type InterestPolicy = "registered" | "everyone"

/**
 * Parses `INTEREST_POLICY`. Unset or empty is `registered`; anything else
 * throws, naming the value, so a typo cannot silently widen or
 * narrow what a monitor watches.
 */
export function parseInterestPolicy(raw: string | undefined): InterestPolicy {
    if (raw === undefined || raw === "") return "registered"
    if (raw === "registered" || raw === "everyone") return raw
    throw new Error(`INTEREST_POLICY must be "registered" or "everyone", got "${raw}"`)
}

export interface WatchedCollection {
    collection: string
    dids: WatchedDidSet
}

/**
 * Parses `MONITOR_COLLECTIONS`: the singleton records watched besides the
 * declaration, as comma-separated `<nsid>/<rkey>` entries, e.g.
 * `app.bsky.actor.profile/self`. The declaration is watched through
 * `MONITOR_COLLECTION`, with its own change push, so listing it here is
 * refused rather than letting it be stored without one. Throws on an empty
 * list, a malformed entry or a duplicate, naming the entry, so a
 * misconfigured monitor fails at startup rather than silently watching less.
 * The NSID check is structural and looser than the atproto spec's. The
 * declaration is recognised by its protocol NSID, not by `MONITOR_COLLECTION`,
 * which a deployment always sets to that same value.
 */
export function parseMonitorCollections(raw: string): WatchedRecord[] {
    if (raw.trim() === "") {
        throw new Error("MONITOR_COLLECTIONS is empty")
    }
    const seen = new Set<string>()
    const records: WatchedRecord[] = []
    for (const part of raw.split(",")) {
        const entry = part.trim()
        const parts = entry.split("/")
        if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
            throw new Error(
                `MONITOR_COLLECTIONS entry "${entry}" is not <nsid>/<rkey>`
            )
        }
        const [collection, rkey] = parts
        if (!isNsid(collection)) {
            throw new Error(
                `MONITOR_COLLECTIONS entry "${entry}" has a collection that is not an NSID`
            )
        }
        if (!isRecordKey(rkey)) {
            throw new Error(
                `MONITOR_COLLECTIONS entry "${entry}" has an invalid record key`
            )
        }
        if (collection === DECLARATION_COLLECTION_NSID) {
            throw new Error(
                `MONITOR_COLLECTIONS entry "${entry}" is the declaration, which MONITOR_COLLECTION watches`
            )
        }
        if (collection === FOLLOW_COLLECTION_NSID || collection === BLOCK_COLLECTION_NSID) {
            throw new Error(
                `MONITOR_COLLECTIONS entry "${entry}" is an edge collection, which the follow index ingests itself`
            )
        }
        if (seen.has(entry)) {
            throw new Error(`MONITOR_COLLECTIONS entry "${entry}" is listed twice`)
        }
        seen.add(entry)
        records.push({ collection, rkey })
    }
    return records
}

const NSID_DOMAIN_SEGMENT = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const NSID_NAME_SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/
const RECORD_KEY = /^[A-Za-z0-9._:~-]{1,512}$/

function isNsid(value: string): boolean {
    const segments = value.split(".")
    if (segments.length < 3) return false
    const name = segments[segments.length - 1]
    return (
        NSID_NAME_SEGMENT.test(name) &&
        segments.slice(0, -1).every((s) => NSID_DOMAIN_SEGMENT.test(s))
    )
}

function isRecordKey(value: string): boolean {
    return RECORD_KEY.test(value) && value !== "." && value !== ".."
}
