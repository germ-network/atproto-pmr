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
    fetchLatestRev,
    guardedFetchBytes,
    resolvePDSEndpoint,
} from "@germ-network/atproto-pmr-core"
import type { FetchedRecord } from "./ingest"

export interface FetchRecordOptions {
    /** The collection carrying the published key. */
    collection: string
    /** Records that carry one key per repo sit at `self`. */
    rkey?: string
    fetchImpl?: typeof fetch
}

/**
 * **CAR, not JSON** — the opposite choice from the relay's own admission
 * check (`declaration.ts`), and for a reason that is about direction: a
 * relay's fetch is consumed and discarded internally, so TLS to the
 * authoritative PDS is the whole trust basis. A monitor's fetch is handed
 * onward to devices, and relay delivery is exactly what discards
 * provenance, so the bytes must carry their own proof.
 *
 * The monitor does not parse the CAR. It stores and serves what it
 * fetched, and the client verifies against the DID document — which is
 * what keeps a monitor light enough that several parties can run one.
 */
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

export async function fetchRecordCar(
    did: string,
    options: FetchRecordOptions
): Promise<FetchedRecord> {
    const fetchImpl = options.fetchImpl ?? fetch
    const { endpoint: pds, signingKey } = await resolvePDSEndpoint(did, fetchImpl)

    const recordUrl = new URL(`${pds}/xrpc/com.atproto.sync.getRecord`)
    recordUrl.searchParams.set("did", did)
    recordUrl.searchParams.set("collection", options.collection)
    recordUrl.searchParams.set("rkey", options.rkey ?? "self")

    const car = await guardedFetchBytes(recordUrl.toString(), fetchImpl, {
        terminalErrorNames: TERMINAL_XRPC_ERRORS,
        permanentErrorNames: PERMANENT_XRPC_ERRORS,
    })
    // `rev` read authoritatively from the PDS, never taken from the wake
    // signal (a hostile feed could otherwise fake or mask a rollback). Shared
    // with the relay's watch via core — see `fetchLatestRev`. One extra round
    // trip per *changed* record is nothing at a single collection's change rate.
    const rev = await fetchLatestRev(pds, did, fetchImpl)
    return { rev, car, source: pds, signingKey }
}
