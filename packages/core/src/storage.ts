/**
 * The storage seam relay logic runs against — the contract from
 * `spec/storage-consistency.md` expressed as types.
 *
 * Nothing here presupposes a backend. `@germ-network/atproto-pmr-cloudflare`
 * is one implementation; a relational adapter is an equally first-class one.
 * Where an operation carries a consistency requirement that a serialized
 * execution model provides for free and a relational backend does not, the
 * requirement is stated on the operation rather than left to be inferred.
 */

/**
 * Whatever an adapter needs to reach one relay's store: an object
 * identifier, a primary key, or the DID itself.
 */
export type Locator = string

/**
 * A mailbox's key *within* one relay's store, both kinds sharing one space:
 * **the counterpart DID verbatim** for a pair mailbox, `grant:<address>`
 * for a grant mailbox. Only one arm carries an added prefix — see
 * `mailbox-key.ts` for why.
 *
 * Routing has already resolved the recipient to this store, so this is a
 * local index, not an address — no global uniqueness, no derivation on the
 * wire.
 *
 * The pair arm deliberately replaced a hashed key. The hash was there for
 * log hygiene, and in this design it bought none: an unsalted digest over a
 * public, enumerable identifier resists nothing, and a per-record salt is
 * impossible for a key that must be computed *before* the record is read.
 * Meanwhile the relay stores the plaintext DID adjacent regardless — in
 * `VerificationHint`, and in the owner-facing listings that have to name a
 * sender the device can decide about — and takes it in request paths that
 * land in access logs. Two side tables existed purely to map the hash back.
 */
export type MailboxKey = PairMailboxKey | GrantMailboxKey

/**
 * A pair mailbox: the counterpart DID, verbatim.
 *
 * Named separately because several operations are pair-only by
 * construction, and saying so in the type is free. Blocking is the clearest
 * case: an owner blocks a *sender DID*, and suppresses a grant address by
 * closing the grant instead — the asymmetry `spec/wire-api.md`'s closure
 * exception spells out. The recovery pool is likewise DID-shaped; a grant
 * address never pools, because holding one already means being provisioned.
 */
export type PairMailboxKey = `did:${string}`

/** A grant mailbox: the derived address, prefixed. */
export type GrantMailboxKey = `grant:${string}`

/** Identifier of a stored message; bodies live in a separate store. */
export type MessageId = string

/** The pair-put anti-replay nonce, taken from the signed payload. */
export type Nonce = Uint8Array

/**
 * What the relay validated a pair put against. Stored *alongside* the
 * entry, never inside the body: the body is self-authenticating and the
 * device re-verifies it, so this is an index and a convenience, not
 * evidence.
 *
 * An adapter that loses or corrupts hints degrades performance. One that
 * lets a hint substitute for verification degrades security.
 */
export interface VerificationHint {
    senderDID: string
    /** RFC 9679 thumbprint of the anchor key the payload verified against. */
    anchorKeyThumbprint: string
}

export interface MessageRef {
    messageId: MessageId
    byteLength: number
    hint?: VerificationHint
}

export type AppendResult =
    /**
     * `persistBody` tells the caller — which sits outside this store and
     * does not, and must not, know whether the sender is blocked — whether
     * it may write this message's body.
     *
     * `true` for a genuinely accepted message; `false` when the append was
     * absorbed by the synthetic mailbox, so "no bytes stored for a blocked
     * sender" holds even though the caller cannot see which branch ran.
     *
     * Never wire-visible: read only by deferred, post-response code. The
     * outcome itself stays identical either way, which is what the response
     * contract requires.
     */
    | { outcome: "appended"; persistBody: boolean }
    /**
     * The nonce was already recorded against a prior accepted outcome for
     * this mailbox — a replay of an already-delivered envelope. The caller
     * answers exactly as it would for the original accepted put, and
     * nothing is written again.
     *
     * Deliberately distinct from `refused`: a refused attempt does NOT
     * record its nonce, so a legitimate retry of the identical signed
     * envelope — the natural client behavior after `429` + `Retry-After` —
     * is evaluated fresh once room exists rather than treated forever as a
     * replay of an attempt that never succeeded.
     */
    | { outcome: "duplicate" }
    /**
     * At capacity. The real path refuses rather than accept-and-evict:
     * drop-oldest would discard a message the sender was told had been
     * accepted, and refusal makes the per-sender quota self-limiting.
     *
     * `retryAfter` is an absolute instant. It MUST come from the same
     * mechanism the synthetic path uses — see
     * `SyntheticBehavior.nextRetryInstant`.
     */
    | { outcome: "refused"; retryAfter: number }

export type PoolAppendResult =
    /**
     * `persistBody` mirrors `AppendResult`'s field, with one more case:
     * `false` when the sender is inside a discard window, since the caller
     * must not write bytes for an entry that was never pooled.
     *
     * This outcome MUST be reached by the same number of round trips and
     * comparable work whether the sender is discarded or genuinely pooled.
     * A discard check that lets the *caller* skip this call makes discard
     * status observable by round-trip count and timing alone.
     */
    | { outcome: "pooled"; persistBody: boolean }
    /** Same reasoning as `AppendResult`'s `duplicate`. */
    | { outcome: "duplicate" }
    /**
     * True exhaustion only: byte cap reached, depth already minimal, and
     * this sender holds no entries yet. Existing senders keep their slots,
     * preserving earlier arrivals rather than letting a late flood displace
     * them. Invisible to the sender — the put still answers `202`.
     */
    | { outcome: "exhausted" }

/** One mailbox and everything currently queued in it. */
export interface MailboxSnapshot {
    key: MailboxKey
    messages: MessageRef[]
}

export interface OpenMailboxesPage {
    entries: MailboxSnapshot[]
    /** Opaque — pass back verbatim to continue. `null` past the last page. */
    nextCursor: string | null
}

export interface PoolSender {
    /** The sender's DID, for the device to decide about. */
    did: string
    /** How many entries are waiting. Never their contents. */
    count: number
}

export interface RegistrationFields {
    did: string
    /**
     * The declared anchor key as a `COSE_Key` blob — self-describing, never
     * a fixed-width column, so a new algorithm arrives as a new identifier
     * rather than a schema migration. Converted at ingest from the
     * declaration's frozen encoding.
     */
    anchorKey: Uint8Array
    /**
     * The Web Push subscription this relay delivers on, where the
     * deployment delegates push. A capability URL and a content key —
     * never a push token (spec/wire-api.md, "the relay never holds a
     * push token").
     */
    pushSubscription?: {
        /** RFC 8030 capability URL. Opaque; never parsed except for its origin. */
        endpoint: string
        /** 32 bytes, AES-256-GCM. Device-provisioned; rotates by registration update. */
        contentKey: Uint8Array
        /** Device-assigned, 0..255, device-global across deliverers. */
        keyId: number
    }
    lastActive: number
}

export interface ResolvedAddress {
    locator: Locator
    /**
     * Surfaced rather than collapsed into `null`, so a caller can do the
     * same work for a closed address as for a live one. Callers MUST treat
     * this as "answer `202` and store nothing", never "return early".
     */
    closed: boolean
    /**
     * The 32-byte symmetric key this grant was issued with — what a
     * [grant put's tag](wire-api.md#grant-address-and-put-tag-derivation)
     * verifies against. Present even when `closed`, since a closed
     * address's put still needs a comparably expensive verification step
     * to run for the uniform-cost contract to hold; only a live, open,
     * tag-verified put may actually store or deliver.
     */
    authKey: Uint8Array
}

/** One issued grant, as listed back to its owner. Never re-carries `key`. */
export interface GrantSummary {
    address: string
    expiresAt: number
    closed: boolean
}

/** Global, small, read on every inbound request. */
export interface Directory {
    /** Hot path: routes every pair put and every owner request. */
    resolve(did: string): Promise<Locator | null>

    /**
     * Grant puts name no DID, so the address resolves globally before any
     * relay is known.
     *
     * CONSISTENCY CONTRACT (5): the same work for a live address, a closed
     * one, and one that never existed. Returning early on a missing row
     * leaks blocking through latency even though the bytes are identical.
     */
    resolveAddress(address: string): Promise<ResolvedAddress | null>

    /** Idempotent on DID. */
    create(did: string, registration: RegistrationFields): Promise<Locator>

    /** Deregistration and dormancy eviction. */
    delete(did: string): Promise<void>

    /**
     * Writes the GLOBAL routing row a grant put resolves against. Always a
     * fresh address the server just derived from a freshly generated
     * `authKey`, so — unlike `setGrantAddressClosed`/`deleteGrantAddress`,
     * below — this needs no ownership check first: nothing else could
     * already be using it.
     */
    createGrantAddress(
        locator: Locator,
        address: string,
        authKey: Uint8Array,
        expiresAt: number
    ): Promise<void>

    /**
     * Updates only the `closed` flag on the routing row.
     *
     * The CALLER is responsible for confirming the address belongs to the
     * owner making the request — this method has no notion of ownership,
     * only routing. See `PMRStore.setGrantClosed`, which is where that
     * record — and therefore that check — actually lives.
     */
    setGrantAddressClosed(address: string, closed: boolean): Promise<void>

    /** Removes the routing row entirely. Same ownership caveat as above. */
    deleteGrantAddress(address: string): Promise<void>
}

/**
 * Everything scoped to one served DID. Every operation is implicitly scoped
 * to its relay; the scope is not a parameter on each call.
 */
export interface PMRStore {
    load(): Promise<RegistrationFields | null>
    update(fields: Partial<RegistrationFields>): Promise<void>

    /**
     * Appends to a provisioned pair mailbox, or advances the synthetic
     * mailbox if the sender is blocked. **The caller cannot tell which
     * happened, and neither can the sender.**
     *
     * CONSISTENCY CONTRACT (1): the capacity check and the write MUST be
     * one atomic step, or two concurrent puts both observe room and both
     * write.
     *
     * CONSISTENCY CONTRACT (7): the nonce seen-check and the append MUST be
     * that same atomic step — not a separate `hasSeen`-then-`append` pair,
     * which reopens the same race for replay instead of capacity. The check
     * MUST apply identically on the blocked path: if a replay advances
     * synthetic state where a real mailbox's replay would not, the
     * difference in when the response flips to `429` is an oracle. And a
     * `refused` outcome MUST NOT record the nonce.
     */
    append(
        key: MailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number
    ): Promise<AppendResult>

    list(key: MailboxKey, limit: number): Promise<MessageRef[]>

    /** CONSISTENCY CONTRACT (6): MUST succeed on an already-removed record. */
    remove(key: MailboxKey, messageId: MessageId): Promise<void>

    /**
     * Best-effort live delivery of a message that was just appended and whose
     * body has already been persisted — `spec/wire-api.md`, "New messages MUST
     * be pushed to an attached connection as they arrive".
     *
     * OPTIONAL: an adapter with no live-connection concept omits it, and the
     * message is still delivered by reconnect-drain or REST catch-up. A caller
     * MUST treat a rejection as nothing-happened — the entry stays queued until
     * acked, so nothing is lost.
     *
     * The bytes are a PARAMETER rather than re-read from the `BodyStore`
     * because the caller writes the body AFTER `append` resolves
     * (`pair-put.ts`, `grant-put.ts`): an implementation that read them back
     * would race its own caller's write.
     *
     * CALLERS MUST NOT call this on a response path. `append` is awaited before
     * a pair put answers, so a push issued from inside it would make the put's
     * latency depend on whether the recipient is connected. This is the reason
     * it is a separate operation rather than folded into `append`.
     */
    deliverLive?(key: MailboxKey, ref: MessageRef, message: Uint8Array): Promise<void>

    /**
     * Best-effort Web Push notification for a message that was just
     * appended and whose body has already been persisted —
     * `spec/wire-api.md`, "Push delivery — Web Push (optional)".
     *
     * OPTIONAL in the same two senses `deliverLive` is: an adapter with no
     * push-delegation concept omits it, and a deployment that HAS the
     * concept but holds no subscription for this registration is expected
     * to no-op internally rather than error. Same bytes-as-parameter
     * reasoning as `deliverLive` — the body is written after `append`
     * resolves, so re-reading it here would race that write.
     *
     * CALLERS MUST NOT call this on a response path, for the identical
     * reason `deliverLive` is a separate operation from `append`: a put's
     * latency must not depend on whether sealing and POSTing a push
     * succeeds, or on the recipient's push service being reachable at all.
     */
    deliverPush?(key: MailboxKey, ref: MessageRef, message: Uint8Array): Promise<void>

    /** True for a provisioned mailbox *or* a blocked sender. */
    hasMailbox(key: MailboxKey): Promise<boolean>

    /**
     * Every mailbox with at least one pending message — pair or grant
     * alike, since the key alone does not say which, and reconnect-drain
     * (the events socket's primitive) treats them identically. Also the
     * hook retention sweeps will use once scheduling exists
     * (`spec/storage-consistency.md` §Scheduling).
     *
     * An empty, provisioned mailbox — awaiting its first message, or
     * fully drained since — is NOT returned: there is nothing to drain.
     * A page CAN legitimately come back with zero entries despite
     * `nextCursor` being non-null, if everything on that page happened to
     * be empty; callers MUST keep paging on `nextCursor` rather than
     * treating an empty page as the end.
     */
    openMailboxes(cursor: string | null, limit: number): Promise<OpenMailboxesPage>

    /**
     * The recovery pool. Do NOT implement by reusing `append` with a
     * different cap: the eviction direction is opposite, and conflating
     * them is how a recovery attempt gets refused or a first-contact
     * message silently dropped.
     *
     * A provisioned mailbox refuses and keeps the OLDEST — first contact is
     * what it is for. The pool keeps the NEWEST, because the freshest
     * attempt carries current state.
     *
     * CONSISTENCY CONTRACT (3): the byte accounting is read-modify-write
     * and needs real atomicity under contention.
     *
     * CONSISTENCY CONTRACT (7) applies here too, and the discard check MUST
     * run inside this call — see `PoolAppendResult`.
     */
    appendToPool(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number
    ): Promise<PoolAppendResult>

    /**
     * Who is waiting in the pool — **DIDs only, never bodies.**
     *
     * The owner-facing listing must name senders the device can actually
     * adjudicate, which is why the key is the DID: the listing is a
     * projection of the pool's own keys rather than a join against a table
     * that maps them back.
     *
     * This is not a new disclosure: the trust model already states that a
     * relay learns the sender DID on a pair-mailbox put — that is the
     * direct cost of requiring authenticated puts.
     */
    poolSenders(): Promise<PoolSender[]>

    /**
     * Adjudication, the device's verdict on a pooled sender.
     *
     * Provisioning moves the pooled entries into a real pair mailbox, so
     * the sender's future puts land normally and the waiting messages are
     * delivered rather than discarded. Returns what moved, so the caller
     * can deliver it.
     */
    provisionFromPool(key: PairMailboxKey, nowSeconds: number): Promise<MessageRef[]>

    /**
     * Discard drops the pooled entries and suppresses the sender until
     * `until`. Time-bounded rather than standing — see `setDiscarded`.
     */
    discardFromPool(key: PairMailboxKey, until: number): Promise<void>

    /**
     * Blocking is reversible — the pair-mailbox counterpart of
     * close/reopen on a grant address — and a blocked sender is never told.
     * The behavior this switches on comes from `SyntheticBehavior`.
     */
    block(key: PairMailboxKey, nowSeconds: number): Promise<void>

    unblock(key: PairMailboxKey): Promise<void>

    /**
     * Blocked sender DIDs, for the owner-facing listing — the block
     * records' own keys, not a second table that can disagree with them.
     */
    listBlocked(): Promise<string[]>

    /**
     * Suppress an unprovisioned sender until `until`, after which it lapses
     * and the sender pools normally again. Time-bounded rather than
     * standing: the device discards a DID it does not recognize *at that
     * moment*, and the pool exists precisely for the case where the
     * device's own knowledge is behind.
     */
    setDiscarded(key: PairMailboxKey, until: number): Promise<void>

    /**
     * The owner's own record of a grant they issued — `issue`, `close`,
     * `reopen`, `invalidate` from `spec/storage-consistency.md` §Grants,
     * split into the four operations below rather than one mutating call,
     * matching the shape blocking and discard already use.
     *
     * This is the record `GET /pmr/v1/grants` lists from, and — just as
     * important — what a `PATCH`/`DELETE` checks BEFORE touching the
     * Directory's global routing row: an owner names an address by value,
     * and this store is what confirms that address is actually theirs
     * before anything routes on their say-so. `authKey` is not readable
     * back through this interface; the owner already holds it from
     * issuance, and re-serving a capability's key is a disclosure with no
     * legitimate reader.
     */
    issueGrant(address: string, authKey: Uint8Array, expiresAt: number): Promise<void>

    listGrants(): Promise<GrantSummary[]>

    /** `null` if this address was never issued by this owner. */
    getGrant(address: string): Promise<GrantSummary | null>

    /**
     * Reversible — the grant counterpart of block/unblock on a pair
     * mailbox. A no-op if `address` is not this owner's.
     */
    setGrantClosed(address: string, closed: boolean): Promise<void>

    /** Permanent, unlike `setGrantClosed`. A no-op if not this owner's. */
    invalidateGrant(address: string): Promise<void>
}

/**
 * Message bodies, kept separate from the queue so the queue stays small
 * regardless of body size. An adapter MAY back both with one table.
 */
export interface BodyStore {
    putBody(id: MessageId, bytes: Uint8Array, expiresAt: number): Promise<void>

    /**
     * CONSISTENCY CONTRACT (4): expiry is an observability rule. A record
     * past `expiresAt` MUST NEVER be returned by any read, regardless of
     * how reclamation works.
     */
    getBody(id: MessageId): Promise<Uint8Array | null>

    deleteBody(id: MessageId): Promise<void>
}

/** Global rather than per-relay: presented before the relay is known. */
export interface ChallengeStore {
    mint(challenge: string, boundTo: string, expiresAt: number): Promise<void>

    /**
     * CONSISTENCY CONTRACT (2): a server challenge gives freshness and
     * bounded replay, NOT use-once. Consumption is best-effort; the
     * load-bearing requirement lands on the operations, which must be
     * replay-tolerant within the TTL.
     */
    consume(challenge: string): Promise<string | null>
}
