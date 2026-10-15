/**
 * Tier 2: the authoritative read, from the DID's own PDS.
 *
 * This is the only thing whose output enters the snapshot. The wake signal
 * that prompted it is not trusted for anything — not the record, and not
 * the `rev` — so both are read again here from the party that is
 * authoritative for the repo.
 *
 * The SSRF guards, and the DID → DID document → PDS resolution, come from
 * `@germ-network/atproto-pmr-core`: the endpoint is attacker-chosen (it
 * comes out of the subject's own DID document), and a second copy of those
 * guards is exactly the copy worth not making.
 */

import {
    fetchDidDocument,
    fetchLatestRev,
    guardedFetchBytes,
    guardedFetchStream,
    pdsResolutionFromDocument,
    type DidDocument,
} from "@germ-network/atproto-pmr-core"
import type { FetchedRepo } from "./follow-backfill"
import type { FetchedDidDocument, FetchedRecord } from "./ingest"

export interface FetchRecordOptions {
    /** The collection carrying the published key. */
    collection: string
    /** Records that carry one key per repo sit at `self`. */
    rkey?: string
    fetchImpl?: typeof fetch
    /** Stamps the returned `didDocument`. Defaults to `Date.now`. */
    nowMs?: () => number
}

export interface FetchHeadRevOptions {
    fetchImpl?: typeof fetch
    /**
     * Handed the DID document the head was resolved through, so the refresh
     * pass keeps the stored copy current at no extra subrequest.
     */
    onDidDocument?: (fetched: FetchedDidDocument) => Promise<void>
    /** Stamps `onDidDocument`'s argument. Defaults to `Date.now`. */
    nowMs?: () => number
}

/**
 * `com.atproto.sync.getRecord`'s own lexicon-declared error set — the
 * XRPC `error` field values that mean this DID's declaration is
 * confirmed unobtainable, not merely unreachable this attempt. Notably
 * does NOT include a bare HTTP 404 with no such body: per the lexicon's
 * own description, `getRecord` proves "the existence OR NON-EXISTENCE of
 * record in the current version of repo" — the reference implementation
 * answers a missing RECORD with 200 and an inclusion-exclusion proof
 * CAR, not an error, so a missing single record never reaches this list
 * at all through the reference implementation. What lands here is the
 * REPO-level terminal states: gone, taken down, suspended, or
 * deactivated. `RecordNotFound` is kept for a non-reference PDS that
 * does use it, per the lexicon.
 */
const TERMINAL_XRPC_ERRORS = [
    "RecordNotFound",
    "RepoNotFound",
    "RepoTakendown",
    "RepoSuspended",
    "RepoDeactivated",
] as const

/**
 * The subset of `TERMINAL_XRPC_ERRORS` with no path back short of the
 * subject republishing from scratch. `RepoTakendown`/`RepoSuspended`/
 * `RepoDeactivated` are deliberately excluded — atproto's own account
 * lifecycle treats all three as *reversible*, and this monitor's own wake
 * signal for that reversal is a jetstream `#account` event for a DID it
 * already holds. Treating them as permanent would mean a DID that gets
 * suspended and later reinstated, without ever republishing its
 * declaration, has no path back to being served or watched again — a
 * bounded, one-time correctness event turned into a standing bug. Only
 * `RecordNotFound`/`RepoNotFound` earn that treatment: a repo or record
 * atproto itself says will never exist at that identity again.
 */
const PERMANENT_XRPC_ERRORS = ["RecordNotFound", "RepoNotFound"] as const

/** The repo's head and the `#atproto` key of the document it was resolved through. */
export interface HeadRev {
    rev: string
    /** `null` when the document carries no `#atproto` key. */
    signingKey: string | null
}

/**
 * The repo's current head `rev` from the DID's own PDS, and the signing key
 * of the document it was resolved through, for the periodic
 * refresh. Re-resolves the DID document each time, so a PDS migration shows
 * up here; a repo-level terminal answer raises `RecordNotFoundError` exactly
 * as `fetchRecordCar` does.
 */
export async function fetchHeadRev(
    did: string,
    options: FetchHeadRevOptions = {}
): Promise<HeadRev> {
    const fetchImpl = options.fetchImpl ?? fetch
    const fetchedAtMs = (options.nowMs ?? Date.now)()
    const document = await fetchDidDocument(did, fetchImpl)
    try {
        // Handed over before the PDS is read out of it: a current document
        // is worth keeping even when it names no PDS.
        await options.onDidDocument?.({
            document: document as unknown as DidDocument,
            fetchedAtMs,
        })
    } catch {
        // Keeping the stored copy current must not cost the refresh its head.
    }
    const { endpoint, signingKey } = pdsResolutionFromDocument(document)
    const rev = await fetchLatestRev(endpoint, did, fetchImpl, {
        terminalErrorNames: TERMINAL_XRPC_ERRORS,
        permanentErrorNames: PERMANENT_XRPC_ERRORS,
    })
    return { rev, signingKey }
}

/**
 * **CAR, not JSON**: the monitor's fetch is handed onward — to devices and
 * to a relay admitting a sender's pair put — and handing a record onward is
 * exactly what discards provenance, so the bytes must carry their own proof.
 *
 * Returns the CAR and the key of the document it was resolved through; ingest
 * verifies the one against the other (`ingest.ts`) before anything is
 * stored, and the consumer verifies again for itself.
 */
export async function fetchRecordCar(
    did: string,
    options: FetchRecordOptions
): Promise<FetchedRecord> {
    const fetchImpl = options.fetchImpl ?? fetch
    const fetchedAtMs = (options.nowMs ?? Date.now)()
    const document = await fetchDidDocument(did, fetchImpl)
    const { endpoint: pds, signingKey } = pdsResolutionFromDocument(document)

    const recordUrl = new URL(`${pds}/xrpc/com.atproto.sync.getRecord`)
    recordUrl.searchParams.set("did", did)
    recordUrl.searchParams.set("collection", options.collection)
    recordUrl.searchParams.set("rkey", options.rkey ?? "self")

    const car = await guardedFetchBytes(recordUrl.toString(), fetchImpl, {
        terminalErrorNames: TERMINAL_XRPC_ERRORS,
        permanentErrorNames: PERMANENT_XRPC_ERRORS,
    })
    return {
        car,
        source: pds,
        signingKey,
        didDocument: { document: document as unknown as DidDocument, fetchedAtMs },
    }
}

export interface FetchRepoOptions {
    /** Bounds the whole read, body included (`FOLLOW_FETCH_TIMEOUT_MS`). */
    timeoutMs: number
    /** The stream errors past this many bytes. */
    maxBytes: number
    fetchImpl?: typeof fetch
    /** Stamps the returned `didDocument`. Defaults to `Date.now`. */
    nowMs?: () => number
}

/**
 * `com.atproto.sync.getRepo` at the DID's own PDS, as a stream for the
 * verifying walk, with the document it was resolved through (read fresh, as
 * `fetchRecordCar` does). A repo-level terminal answer raises
 * `RecordNotFoundError` as the other fetches do.
 */
export async function fetchRepoCar(
    did: string,
    options: FetchRepoOptions
): Promise<FetchedRepo> {
    const fetchImpl = options.fetchImpl ?? fetch
    const fetchedAtMs = (options.nowMs ?? Date.now)()
    const document = await fetchDidDocument(did, fetchImpl)
    const { endpoint: pds, signingKey } = pdsResolutionFromDocument(document)

    const repoUrl = new URL(`${pds}/xrpc/com.atproto.sync.getRepo`)
    repoUrl.searchParams.set("did", did)

    const car = await guardedFetchStream(repoUrl.toString(), fetchImpl, {
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        terminalErrorNames: TERMINAL_XRPC_ERRORS,
        permanentErrorNames: PERMANENT_XRPC_ERRORS,
    })
    return {
        car,
        source: pds,
        signingKey,
        didDocument: { document: document as unknown as DidDocument, fetchedAtMs },
    }
}
