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
    guardedFetchBytes,
    guardedFetchJSON,
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

    const car = await guardedFetchBytes(recordUrl.toString(), fetchImpl)
    const rev = await fetchLatestRev(pds, did, fetchImpl)
    return { rev, car, source: pds, signingKey }
}

/**
 * The repo `rev`, read from the PDS rather than taken from the wake
 * signal.
 *
 * Trusting the stream's `rev` would hand a hostile feed the ability to
 * fake a regression alarm, or to mask a real one by reporting a rev that
 * only moves forward — and the regression rule is the thing this whole
 * component exists to enforce. One extra round trip per *changed* record
 * is nothing at the rate a single collection changes.
 *
 * `getLatestCommit` gives the repo's rev, which is what the comparison
 * rules in `trust-model.md` are written against: a rev that moves
 * backwards is a rollback, and identical revs with differing content is
 * equivocation. It advances on any commit to the repo, not only this
 * record — harmless here, because the collection filter means a fetch only
 * happens when this record actually changed.
 */
async function fetchLatestRev(
    pds: string,
    did: string,
    fetchImpl: typeof fetch
): Promise<string> {
    const url = new URL(`${pds}/xrpc/com.atproto.sync.getLatestCommit`)
    url.searchParams.set("did", did)
    const body = (await guardedFetchJSON(url.toString(), fetchImpl)) as {
        rev?: unknown
    }
    if (typeof body.rev !== "string" || body.rev.length === 0) {
        throw new Error("getLatestCommit returned no rev")
    }
    return body.rev
}
