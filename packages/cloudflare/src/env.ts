import type { PMRObject } from "./pmr-object"

/**
 * Bindings this package expects. See `wrangler.example.toml`.
 *
 * Every tunable is a string because Workers `[vars]` are strings; they are
 * parsed at the point of use. All are **implementation-defined** — the
 * specification fixes none of these values, and the example config is
 * illustrative rather than a recommendation.
 *
 * A deployment is free to extend this interface with its own bindings; the
 * package only reads the ones declared here.
 *
 * Generic over the Durable Object class because subclassing `PMRObject` is
 * the documented way to supply your own synthetic behavior, and
 * `protected synthetic` makes a subclass non-assignable to the base in
 * both directions. Without the parameter every adopter who followed that
 * advice would hit a type error here.
 */
export interface PMREnv<TPMR extends PMRObject = PMRObject> {
    /** DID → locator. Global, small, read on every inbound request. */
    pmrDirectory: KVNamespace
    /** Grant address → locator. Resolves before any relay is known. */
    addresses: KVNamespace
    /** Message bodies, kept out of the queue. */
    messages: KVNamespace
    /**
     * Server-issued challenges. Global rather than per-relay: a challenge
     * is presented before the relay is known.
     */
    challenges: KVNamespace

    pmrs: DurableObjectNamespace<TPMR>

    /** Per-sender capacity of a provisioned pair mailbox. */
    MAX_MESSAGES_PER_PAIR_SENDER: string

    /** Recovery pool: bounded by bytes, never by sender count. */
    POOL_CAP_BYTES: string
    POOL_DEPTH_PER_SENDER: string
    POOL_DEPTH_UNDER_PRESSURE: string

    /**
     * `active`, `draining`, or `absent` — deployment-wide policy for grant
     * issuance. Operating mailboxes is not configurable: a relay serves
     * both kinds or is not a relay. This is the one thing that winds down,
     * because it is the one thing vended to third parties.
     */
    GRANT_LIFECYCLE: string
}
