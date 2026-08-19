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
export { kvSnapshotStore } from "./snapshot-store"
export type { MonitorEnv } from "./env"
