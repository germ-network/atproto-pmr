/**
 * A monitor's own-DID push registration — `spec/key-transparency.md`,
 * §Registration.
 *
 * Deliberately **not** stored on a relay's registration record, even where
 * a deployment co-hosts both: a monitor must serve a DID that holds no
 * relay registration at all (the "monitor with no PMR" shape), and its
 * lifetime must survive that DID later deregistering from the relay. Tying
 * the two together would make deregistering from mail delivery silently
 * turn off key-transparency alerts — a security-relevant side effect on a
 * channel whose entire value is that it cannot be quietly disabled.
 */

/** One DID's push registration with this monitor. */
export interface MonitorRegistration {
    did: string
    /**
     * The anchor key this registration authenticates against, as a
     * `COSE_Key` blob — self-describing, like `RegistrationFields.anchorKey`
     * in the PMR's own storage. Set once, at create, from the DID's
     * then-current declaration, and **never rewritten by a later `POST`** —
     * see `registration-endpoint.ts`'s module comment for why a rebind
     * cannot be allowed to change it.
     */
    anchorKey: Uint8Array
    /**
     * Required, unlike the PMR's optional subscription: a monitor
     * registration with no destination has no meaning. Rotates freely by
     * `POST`, since only the destination changes, not the key that
     * authorizes the change.
     */
    pushSubscription: {
        /** RFC 8030 capability URL. Opaque; never parsed except for its origin. */
        endpoint: string
        /** 32 bytes, AES-256-GCM. Device-provisioned. */
        contentKey: Uint8Array
        /** Device-assigned, 0..255, device-global across deliverers — this
         *  registration's own `keyId`, distinct from any the same device
         *  uses with a PMR (`push-delegation.md`: each deliverer holds its
         *  own subscription). */
        keyId: number
    }
    /** Last write, not first: a subscription rebind refreshes this too. */
    registeredAt: number
}

/**
 * The monitor's registration seam. An adapter over KV is the reference
 * implementation (`packages/monitor-cloudflare`); nothing here assumes one.
 *
 * **Eventual consistency is an accepted, documented risk for v1** where the
 * adapter is KV-backed: a `load()` racing a very recent `put()`/`delete()`
 * for the same DID can observe stale state for the propagation window. The
 * bounded consequences: a stale-absent read right after a DID's first
 * registration could downgrade what should be a rebind into a create,
 * briefly reopening the window `registration-endpoint.ts`'s stored-key rule
 * otherwise closes; a stale-present read after a delete can produce one
 * extra push to a subscription the owner just revoked. Both are narrow and
 * self-limiting, and — because a monitor's whole design is redundant,
 * independently-run coverage rather than a single source of truth — a
 * device can always fall back to polling the digest for its own DID
 * regardless of what happens to this channel.
 *
 * A related, also-accepted risk: create-vs-rebind takes a visibly different
 * path (a create resolves the DID's declaration over the network; a rebind
 * only reads this store), so a caller who can mint an anchor challenge for
 * any DID — minting is pre-auth by design — can distinguish "has a
 * registration" from "does not" by response latency, despite every failure
 * body being identical. This is a timing side channel on registration
 * *existence* only, never on content, and is accepted for the same reason
 * as the consistency window above: closing it costs a network resolution
 * on every request rather than only on create, for a v1 whose more
 * important property (a PDS cannot silently rebind or silence an existing
 * registration) does not depend on it.
 */
export interface MonitorRegistrationStore {
    load(did: string): Promise<MonitorRegistration | null>
    put(registration: MonitorRegistration): Promise<void>
    delete(did: string): Promise<void>
}
