import type { MonitorIngest } from "./ingest-object"

/**
 * Bindings this package expects. See `wrangler.example.toml`.
 *
 * Every tunable is a string because Workers `[vars]` are strings; they are
 * parsed at the point of use, and all of them are
 * **implementation-defined** — the specification fixes none of these.
 */
export interface MonitorEnv<TIngest extends MonitorIngest = MonitorIngest> {
    /**
     * The snapshot, and sealed digest windows: bytes the monitor serves
     * rather than compares. Read by plain Workers on the public paths, so
     * it is deliberately not Durable Object storage.
     *
     * Entries carry **no TTL** — a record unchanged for years must still
     * be served — and are disposable only in the sense that they are
     * rebuildable from replay.
     */
    records: KVNamespace

    /**
     * **A singleton.** One socket, one cursor, one `rev` index for the
     * whole coverage. Address it by a fixed name, never per user: the
     * consumer is network-wide where a relay's objects are per
     * registration.
     */
    ingest: DurableObjectNamespace<TIngest>

    /** The collection carrying the published key. */
    MONITOR_COLLECTION: string

    /**
     * The stream to consume. A monitor is not bound to any one provider;
     * this is a URL so an operator can point at a self-hosted instance,
     * which is the upgrade path away from depending on someone else's
     * view of the network.
     */
    JETSTREAM_URL: string

    /**
     * Watchdog interval, milliseconds. An outbound socket does not
     * hibernate, so the object is evicted on the platform's own schedule
     * and the alarm is what brings the connection back. Eviction is
     * expected rather than exceptional; every gap is closed by the cursor.
     */
    WATCHDOG_INTERVAL_MS: string

    /** How many owed fetches to settle per wake. */
    SETTLE_BATCH: string

    /**
     * Digest window width in milliseconds. Published with every filter, so
     * it can change without coordinating a flag day — but a change is
     * visible to clients mid-flight, since window numbers are derived from
     * it.
     */
    DIGEST_WINDOW_MS: string

    /**
     * How long a sealed digest window stays fetchable. Records never
     * expire; windows do — past this a client falls back to the direct
     * re-verification it would do with no digest at all.
     */
    WINDOW_RETENTION_SECONDS: string
}
