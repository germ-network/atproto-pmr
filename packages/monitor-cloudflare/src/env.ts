import {
    parseInterestPolicy,
    parseMonitorCollections,
    type InterestPolicy,
    type WatchedRecord,
} from "@germ-network/atproto-pmr-core"
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
     * **A singleton.** One Jetstream socket and cursor (plus the optional
     * PLC export socket and cursor, shared by the signing-key cache and the
     * stored DID documents), one `rev` index for the whole
     * coverage. Address it by a fixed name, never per user: the consumer is
     * network-wide where a relay's objects are per registration.
     */
    ingest: DurableObjectNamespace<TIngest>

    /** The collection carrying the published key. */
    MONITOR_COLLECTION: string

    /**
     * The singleton records kept beside the declaration for every DID in
     * interest, as comma-separated `<nsid>/<rkey>` (core
     * `parseMonitorCollections`), e.g. `app.bsky.actor.profile/self`. Unset or
     * empty keeps none.
     */
    MONITOR_COLLECTIONS?: string

    /**
     * Who is watched (core `parseInterestPolicy`): `registered` (the default)
     * keeps registered DIDs and every DID they follow; `everyone` keeps every
     * declaration holder. Anything else fails the object at startup.
     */
    INTEREST_POLICY?: string

    /**
     * How long (ms) an `unregister` waits before it applies, default 10
     * minutes; a `register` inside it cancels it, so a registration replaced
     * by delete-then-create disposes of nothing.
     */
    UNREGISTER_GRACE_MS?: string

    /**
     * Longest (ms) the follow/profile stream's cursor goes unpersisted while
     * it only drops events, default 5 s. An event kept persists it at once.
     */
    FOLLOW_CURSOR_PERSIST_MS?: string

    /** Interest transitions applied per alarm, default 64. */
    INTEREST_BATCH?: string

    /**
     * The follow-edge index (D1, schema in `migrations/`): written only by
     * this object, read by the graph routes through `d1FollowEdgeStore`,
     * `d1GraphChangeLog` and `d1InterestReader`. Required: the object fails
     * at startup without it, as it does for `pmrDirectory` under `registered`.
     */
    graph?: D1Database

    /**
     * The relay's directory of registered DIDs (bare `<did>` keys), read only:
     * the daily reconcile lists it to repair a missed register or unregister.
     * Required under `registered` (the object fails at startup without it);
     * under `everyone`, unbound leaves the registration calls alone to keep
     * the registered set.
     */
    pmrDirectory?: KVNamespace

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
     * DIDs whose held snapshot is re-confirmed against its source per
     * alarm. Population × alarm interval ÷ this is how stale a quiet
     * sender's snapshot can get. Past the relay's snapshot age bound (24 h) it
     * checks the sender's declaration directly instead.
     */
    REFRESH_BATCH: string

    /** A snapshot not confirmed for this long (ms) is due for re-confirmation. */
    REFRESH_STALE_AFTER_MS: string

    /**
     * The same bound for a DID that holds no declaration (only its secondaries
     * are kept), default 86_400_000 (a day). Live profile events keep those
     * current in between.
     */
    REFRESH_NONHOLDER_STALE_AFTER_MS?: string

    /**
     * The PLC directory's export stream (`wss://plc.directory/export/stream`,
     * written as https). One socket and cursor feed both caches it keeps
     * current: the relay's cached did:plc signing keys (`sk:` in `records`)
     * and the stored DID documents (`doc:`, with `plc:coverage`). Optional:
     * unset, no second socket is opened, cached keys follow their TTL alone,
     * and stored did:plc documents follow only the refresh pass and are
     * trusted only for the direct-fetch TTL. Must be the same directory the
     * monitor's fetches and the relay's fallback read (plc.directory): a
     * mirror's coverage says nothing about what they see. The cursor is
     * stored per URL, because `seq` is per directory host.
     */
    PLC_EXPORT_STREAM_URL?: string

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

    /**
     * Web Push configuration for the own-DID push — all optional, and
     * required together (`push-sender.ts`'s `monitorWebPushSender`
     * contract: partial configuration is treated the same as none). The
     * same var names the PMR side uses (`@germ-network/atproto-pmr-cloudflare`'s
     * `PMREnv`), deliberately: a deployment that co-hosts a relay and a
     * monitor configures push once and satisfies both interfaces from the
     * same env, rather than each needing its own VAPID keypair and secret.
     */
    HOST_NAME?: string
    VAPID_PUBLIC_KEY?: string
    VAPID_PRIVATE_KEY?: string
    VAPID_SUBJECT?: string
    PUSH_MAX_SEALED_BYTES?: string
    PUSH_TTL_SECONDS?: string
}

/** The configured secondaries; none when `MONITOR_COLLECTIONS` is unset or empty. */
export function monitorCollections<TIngest extends MonitorIngest>(
    env: MonitorEnv<TIngest>
): WatchedRecord[] {
    const raw = env.MONITOR_COLLECTIONS
    if (raw === undefined || raw.trim() === "") return []
    return parseMonitorCollections(raw)
}

/** The configured interest policy; throws on an unknown value, naming it. */
export function interestPolicy<TIngest extends MonitorIngest>(
    env: MonitorEnv<TIngest>
): InterestPolicy {
    return parseInterestPolicy(env.INTEREST_POLICY)
}
