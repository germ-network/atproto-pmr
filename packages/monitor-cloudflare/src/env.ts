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
     * Bytes of filter a digest response carries before deferring the rest
     * to the next page. A **byte** budget rather than a window count, so
     * it does not go stale as the population grows: fatter windows simply
     * mean fewer per page. This is the knob to tune against observed
     * response sizes in production.
     */
    DIGEST_BYTE_BUDGET: string

    /**
     * Target false-positive rate for new filters. Free to retune at any
     * time: every sealed window carries its own `bits` and `hashes`, so
     * windows sealed under an older value stay readable.
     */
    DIGEST_FALSE_POSITIVE_RATE: string

    /**
     * Digest window width in milliseconds. Published with every filter, so
     * it can change without coordinating a flag day for *clients*.
     *
     * **Changing it is not free on the server.** Windows are identified by
     * their start instant rather than an index — which is what stops every
     * key meaning two things — but an instant divisible by both the old
     * and new width is still a shared key, and more fundamentally
     * `sealedThrough` promises that an absent window below it is
     * *empty* rather than *unknown*. A granularity change breaks that
     * promise. So retuning this MUST be accompanied by clearing the sealed
     * windows and the digest marker (`DigestMarker`, in `SnapshotStore`);
     * clearing the marker to absent is itself a defined, safe state
     * (`serveDigest` answers with the request's own cursor unchanged,
     * never a false coverage claim) until the next seal republishes it —
     * clients then see `oldest` jump forward and fall back to direct
     * re-verification, the defined behaviour for a gap.
     */
    DIGEST_WINDOW_MS: string

    /**
     * How long a sealed digest window stays fetchable. Records never
     * expire; windows do — past this a client falls back to the direct
     * re-verification it would do with no digest at all.
     */
    WINDOW_RETENTION_SECONDS: string

    /**
     * The relay to enumerate for tier 3's baseline build
     * (`com.atproto.sync.listReposByCollection`) — how a DID published
     * before this monitor's connection opened, and never touched since,
     * still gets discovered. The live tail alone cannot see it.
     */
    BACKFILL_RELAY_URL: string

    /** DIDs to discover per relay page, per wake. */
    BACKFILL_BATCH: string

    /**
     * The registration surface: own-DID push. Optional — a deployment that
     * does not bind this serves the monitor with no registration/push
     * capability at all (`onChange` no-ops), matching `webPushSender`'s
     * "not configured → no-op" contract in `@germ-network/atproto-pmr-cloudflare`.
     *
     * Deliberately not the relay's own storage: see `MonitorRegistration`'s
     * doc comment in `@germ-network/atproto-pmr-monitor` for why a
     * registration must outlive a co-hosted relay registration.
     */
    registrations?: KVNamespace
}
