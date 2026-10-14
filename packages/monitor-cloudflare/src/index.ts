/**
 * `@germ-network/atproto-pmr-monitor-cloudflare` — a Durable Object and KV
 * implementation of the seams in `@germ-network/atproto-pmr-monitor`.
 *
 * `@germ-network/atproto-pmr-monitor` is a **peer** dependency: install it
 * yourself, from the same source as this package, so there is exactly one
 * copy and the types unify.
 *
 * A consuming Worker MUST re-export the Durable Object class from its own
 * entry point, because wrangler looks for it on `main`:
 *
 *     export { MonitorIngest } from "@germ-network/atproto-pmr-monitor-cloudflare"
 *
 * **The authoritative fetch is not implemented here.** Subclass to supply
 * it — resolving a DID document and reading that DID's own PDS is a
 * deployment's policy (which resolver, which timeouts, whether to verify
 * the CAR proof), not a storage adapter's:
 *
 *     export class MyMonitor extends MonitorIngest {
 *         protected async fetchRecord(did: string) { … }
 *     }
 *
 * **`MonitorIngest` is a singleton.** Address it by a fixed name. The
 * stream, the cursor, and the `rev` index are network-wide, where a
 * relay's objects are per registration — which is also why a monitor
 * cannot simply be folded into a relay object, whatever the packaging.
 *
 * Set `PLC_EXPORT_STREAM_URL` to also consume the PLC directory's export
 * stream on a second outbound socket, with one cursor, keeping two things
 * current. The relay's cached did:plc signing keys: both sides of that cache
 * go through `kvSigningKeyCache(env)` (`sk:<did>` in `records`), so point the
 * relay's `cachedSigningKeyResolver` at it. And a stored DID document per
 * watched DID, published to `doc:<did>` with the stream's coverage in
 * `plc:coverage`: a relay reads them through `kvDidDocuments(env)` and
 * `kvPlcCoverage(env)` into `storedSigningKeyResolver`, with
 * `cachedSigningKeyResolver` as its fallback. Wiring that into the relay's
 * `resolveSigningKey` is the deployment's step. A subclass that overrides
 * `fetchHeadRev` must hand its document to `recordDidDocument` to keep the
 * stored copy current, and a `fetchRecord` not built on `fetchRecordCar`
 * must return the document it resolved as `didDocument`.
 *
 * The public read paths — the record fetch and the change digest — are
 * deliberately *not* here: they are KV reads that belong in a plain
 * Worker, so the community view scales and caches like the public data it
 * is. Use `kvSnapshotStore` from the request handler.
 *
 * The registration surface's endpoints (`@germ-network/atproto-pmr-monitor`'s
 * `handleMonitorRegistrationCreate`/`handleMonitorRegistrationDelete`) are
 * request-handler code too, and need a `MonitorRegistrationStore` to wire
 * up — `kvMonitorRegistrationStore` is that adapter, for the same reason
 * `kvSnapshotStore` is exported here rather than kept internal to
 * `MonitorIngest`. `monitorWebPushSender` stays unexported: unlike the
 * store, nothing outside `MonitorIngest`'s own `onChange`/`onRegression`
 * needs to compose a sender, matching `@germ-network/atproto-pmr-cloudflare`'s
 * `webPushSender`, which is the same kind of internal-only composition.
 */

export { MonitorIngest } from "./ingest-object"
export { kvMonitorRegistrationStore } from "./registration-store"
export { kvSnapshotStore, kvDeclarationSnapshots } from "./snapshot-store"
export { kvGraphProjections } from "./graph-projection-store"
export { kvDidDocuments, kvPlcCoverage } from "./did-document-store"
export { kvSigningKeyCache } from "./signing-key-store"
export type { MonitorEnv } from "./env"
