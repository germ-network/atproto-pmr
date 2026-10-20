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

import type { Admission, PoolVerdict } from "./admission.js"
import type { SummaryIndex } from "./summary.js"

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
    /**
     * CID of the sender's declaration record the relay verified the payload
     * against (CIDv1, dag-cbor, sha2-256, base32-lower: `bafyrei…`). A
     * freshness cue for the device — the newest declaration this relay has
     * seen — not a trust signal and not a key identifier.
     */
    declarationCID: string
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
    /**
     * The receive-time verdict the sender's latest pooled put carried, so the
     * device judges with the relay's reason rather than recomputing it.
     * Absent for an entry pooled without one.
     */
    verdict?: PoolVerdict
}

/**
 * What `receive` did with a pair put. As with `AppendResult`, the caller
 * cannot tell a synthetic (blocked) absorption from a real append: both are
 * `queued`, the synthetic one with `persistBody: false`.
 */
export type ReceiveResult =
    /**
     * Appended to the sender's mailbox; deliver it if `persistBody`. `moved`
     * holds pooled entries a `yes` moved into the mailbox ahead of it, older
     * first, whose bodies are already stored — deliver them before this one.
     */
    | { outcome: "queued"; persistBody: boolean; moved?: MessageRef[] }
    /** Pooled (or dropped inside a discard window, `persistBody: false`); never delivered. */
    | { outcome: "pooled"; persistBody: boolean }
    | { outcome: "duplicate" }
    | { outcome: "refused"; retryAfter: number }
    | { outcome: "exhausted" }

/**
 * Who set a relay block. A `bsky` marker mirrors the owner's Bsky block and
 * is not lifted by the relay's own view of Bsky; only a device unblock lifts a
 * block, whichever marker it carries.
 */
export type BlockSource = "device" | "bsky"

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

/**
 * Per-registration state of the own-DID declaration watch
 * (`spec/wire-api.md`, "A registration lives while the anchor key stays in the
 * DID's declaration"; `spec/storage-consistency.md`, "the last observed
 * declaration revision, the last check time, the currently trusted anchor key,
 * and the paused flag"). The currently-trusted key is `RegistrationFields.
 * anchorKey` and is not duplicated here; this holds the flag and the stamp.
 *
 * MUST be keyed by DID, never by anchor key, so a disappearance or a later
 * rotation cannot orphan it (`spec/wire-api.md`). The decision logic that
 * produces it is in `watch.ts`.
 */
export interface WatchState {
    /**
     * True while the owner's declared anchor key is confirmed gone or changed.
     * While set the registration stops acting on the DID's behalf, but still
     * queues all mail. Reversible: cleared when the
     * trusted key is observed present again. Never triggers deregistration.
     */
    paused: boolean
    /** Seconds since the epoch of the last completed re-check; `0` = never. */
    lastCheckAt: number
    /**
     * The repo rev observed at the last re-check accepted under the watermark —
     * the spec's "last observed declaration revision"
     * (`spec/storage-consistency.md`). Advanced on ANY accepted rev-carrying
     * apply, not only one that changes `paused` (a `present` over an
     * already-live registration still advances it), so the floor tracks the
     * freshest observation rather than the last flag flip. The monotonic-rev
     * watermark
     * (`spec/trust-model.md`): `applyDeclarationOutcome` refuses any re-check
     * whose observed rev is not strictly newer than this, so a reordered or
     * replayed recheck (Cloudflare Queues are unordered + at-least-once) cannot
     * clobber a fresher pause decision with a staler one, and a rev that moved
     * *backwards* is a rollback it declines. Optional: never-checked, and
     * pre-existing rows written before this field existed, read as absent and
     * are treated as "no floor yet" (any rev advances).
     */
    lastObservedRev?: string
}

/**
 * What one re-check of the owner's own declaration concluded, against the key
 * the relay currently trusts (`watch.ts`, `classifyDeclaration`): `present`
 * (unpause), `absent` — gone or a different key, rotation being deferred to
 * GER-2212 — (pause), or `unknown` (a transient/unreachable failure, which
 * moves nothing so a PDS blip never pauses a healthy mailbox).
 */
export type WatchOutcome = "present" | "absent" | "unknown"

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

/**
 * A monitor that keeps its interest set in step with registrations: the
 * directory tells it when a DID registers or deregisters. Best-effort — the
 * monitor reconciles against the directory on its own schedule, so a lost
 * call only delays it.
 */
export interface MonitorRegistrationNotify {
    register(did: string): Promise<void>
    unregister(did: string): Promise<void>
}

/**
 * A monitor that takes re-check requests from device reads of lapsed
 * declarations. Best-effort: a request only reorders work already due, so a
 * lost call only delays a refresh the monitor would make anyway.
 */
export interface MonitorRecheckRequest {
    requestRefresh(did: string, requestedAtMs: number): Promise<void>
}

/**
 * A monitor that answers, from its verified snapshot, what a DID's
 * declaration currently names as its anchor. The only source that may
 * inactivate a registration (R88): unlike the owner-PDS read in `watch.ts`,
 * it is proof-checked, so a misserving PDS cannot retire a registration.
 */
export interface MonitorVerifiedAnchorRequest {
    verifiedAnchorOf(did: string): Promise<VerifiedAnchorObservation>
}

/**
 * - `present`: the verified declaration names `anchorKey` (a `COSE_Key` blob).
 * - `absent`: the declaration record is verifiably gone from a live repo.
 * - `unknown`: anything else — not yet verified, no snapshot, or a
 *   repo-level state such as deactivation, which only pauses (R88).
 */
export type VerifiedAnchorObservation =
    | { state: "present"; anchorKey: Uint8Array }
    | { state: "absent" }
    | { state: "unknown" }

/**
 * A registration the monitor's verified view retired. Terminal: it accepts no
 * new mail and never becomes active again; its backlog is kept, unread, until
 * `destroyAt`, then destroyed.
 */
export interface InactiveRegistration {
    locator: Locator
    inactiveAt: number
    /** Fixed once, at deactivation: the backlog is destroyed then. */
    destroyAt: number
}

/** Global, small, read on every inbound request. */
export interface Directory {
    /** Hot path: routes every pair put. The active registration only. */
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

    /** Idempotent on the DID's active registration; its inactive set is kept. */
    create(did: string, registration: RegistrationFields): Promise<Locator>

    /**
     * Deregistration and dormancy eviction, and the replace path of a new
     * key's registration: removes the DID's active registration and destroys
     * it with its mail. Inactive registrations and tombstones are untouched.
     */
    delete(did: string): Promise<void>

    /**
     * Retires the active registration: it becomes inactive at `nowSeconds`
     * and keeps its backlog, unread, until the retention deadline.
     * Beyond the inactive cap the oldest inactive registration is destroyed.
     * Does nothing, returning `null`, unless the active registration is
     * `expectedActive`: a caller that read an earlier registration must not
     * retire the one that replaced it. Returns the retired locator.
     *
     * Order: the object is marked inactive before the row moves it, so a
     * crash between leaves an active-looking row over an object that already
     * refuses mail, never an inactive entry that still accepts it. The row is
     * rewritten without compare-and-swap; a lost update can orphan an
     * inactive object, which its own retention alarm still destroys.
     */
    deactivate(
        did: string,
        nowSeconds: number,
        expectedActive: Locator
    ): Promise<Locator | null>

    /**
     * Deregisters the active registration if `anchorThumbprint` is its
     * anchor's, destroys it, and tombstones that anchor so it never registers
     * again. A tombstone is written once and never rewritten. Other anchors
     * of the same DID are unaffected.
     */
    deregister(did: string, anchorThumbprint: Uint8Array): Promise<void>

    isTombstoned(did: string, anchorThumbprint: Uint8Array): Promise<boolean>

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
     * Makes this registration inactive from `atSeconds`: from then on it
     * stores no new mail of any kind, and at `destroyAtSeconds` it destroys
     * itself. Idempotent; the first call's times stand.
     */
    markInactive(atSeconds: number, destroyAtSeconds: number): Promise<void>

    /**
     * Whether the monitor has verified this registration's own anchor. Until
     * then the monitor's view may predate the registration, so it cannot
     * retire it.
     */
    isMonitorConfirmed(): Promise<boolean>
    markMonitorConfirmed(): Promise<void>

    /** `null` while active. */
    readInactive(): Promise<{ inactiveAt: number; destroyAt: number } | null>

    /**
     * The own-DID declaration watch's state (`watch.ts`, `WatchState`).
     * `readWatchState` MUST return `INITIAL_WATCH_STATE` (unpaused) for a
     * registration that has never been checked, so a store with no watch row
     * behaves as live rather than as an error. Scoped to this registration,
     * like everything else on this store.
     */
    readWatchState(): Promise<WatchState>
    writeWatchState(state: WatchState): Promise<void>

    /**
     * The summary index served under `token` (`summary.ts`). Keeps only the
     * most recently served `SUMMARY_TOKENS_KEPT`; storing one past that drops
     * the oldest. Each index is its own entry, so storing one never rewrites
     * another. Private to this registration. `replaces`: a token the client
     * has paged past (its index has `more` set); the new token takes its
     * slot, so a paged sync holds one slot however many pages it takes.
     */
    putSummaryIndex(
        token: string,
        index: SummaryIndex,
        servedAtMs: number,
        replaces?: string
    ): Promise<void>
    /**
     * Null for a token never served here or since dropped. The token is
     * client-supplied: one that cannot be a key is simply not held. An index
     * stored without verdicts reads with `verdicts` empty.
     */
    getSummaryIndex(token: string): Promise<SummaryIndex | null>

    /**
     * Fold one re-check outcome into this registration's watch state — the
     * atomic read-modify-write of the paused flag (`watch.ts`,
     * `reconcileWatchState`). The DRIVER decides when to call this and does the
     * authoritative declaration re-fetch + classification itself (germ: a
     * firehose-fed queue consumer; a relational adopter: a cron + `dueForWork`
     * sweep), so this method takes no network dependency — it only records the
     * conclusion. A caller passes `present`/`absent`; `unknown` is a no-op that
     * only stamps the check, and a driver typically retries a transient rather
     * than recording it. MUST be atomic (contract 1's shape) so concurrent
     * rechecks for one DID cannot interleave the read and the write.
     *
     * `observedRev` is the repo rev the driver read authoritatively at re-check
     * time (`resolveDeclarationWithRev`) — the monotonic-rev watermark
     * (`WatchState.lastObservedRev`). When present, a `present`/`absent` outcome
     * whose rev is not strictly newer than the stored one is REFUSED (the flag
     * is left as-is; only the check is stamped): a reordered/replayed recheck,
     * or a PDS rollback, must not move a pause set from a fresher observation.
     * Omitted (a confirmed-gone repo with no rev to read) applies the outcome
     * without advancing the watermark — pausing is fail-safe. A driver MUST NOT
     * omit the rev for a `present`/unpause, though: an unpause advances no
     * watermark and so would not be replay-safe, and the driver treats a present
     * read whose rev it could not obtain as transient instead (the deployment's
     * `recheckAndApply`).
     */
    applyDeclarationOutcome(
        outcome: WatchOutcome,
        nowSeconds: number,
        observedRev?: string
    ): Promise<void>

    /**
     * Appends to a provisioned pair mailbox, or advances the synthetic
     * mailbox if the sender is blocked. **The caller cannot tell which
     * happened, and neither can the sender.**
     *
     * PAUSE does not gate admission: a paused registration (`watch.ts`)
     * queues `did:`- and `grant:`-keyed puts exactly as an active one.
     * INACTIVE (`markInactive`) does: every put, grant-keyed included, is
     * answered as a real append would be — `appended` with `persistBody:
     * false`, no bytes, no delivery, no nonce recorded.
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
     * Route one adjudicated pair put in a single atomic step, by the sender's
     * standing and the recipient's `admission`:
     *
     *  - a `blocked` admission mirrors the Bsky block (`block(key, now,
     *    "bsky")`; no marker is written over a device block) and the put is
     *    absorbed synthetically;
     *  - no verdict lifts a block marker: a Bsky-blocked sender stays
     *    synthetic until the device unblocks it;
     *  - a device-blocked sender is absorbed synthetically;
     *  - a device-provisioned sender is appended, whatever the verdict;
     *  - `yes` appends to a mailbox marked admitted, opened if none is held,
     *    moving any pooled entries into it — even inside a discard window;
     *  - `no` / `unknown` pools the put with its verdict, as `appendToPool`
     *    (so a live discard window drops it).
     *
     * Order: nonce and inactive checks first (nothing at all is written for a
     * duplicate or an inactive registration), then the block-marker transition,
     * then capacity: a `yes` is refused only when the new ref itself does not
     * fit (a refusal writes no mailbox, mark or move); otherwise the oldest
     * pooled entries that fit ahead of it move in and the rest stay pooled
     * with their verdict. Then the writes.
     */
    receive(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        admission: Admission
    ): Promise<ReceiveResult>

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
     *
     * An inactive registration (`markInactive`) answers `pooled` with
     * `persistBody: false` and records nothing; a paused one pools as an
     * active one does.
     */
    appendToPool(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        /** Recorded as the sender's latest verdict when the put is pooled. */
        verdict?: PoolVerdict
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
     *
     * `source` defaults to `device`. A device block of a sender already
     * blocked from Bsky takes the marker over, so it leaves the Bsky-mirrored
     * set; a Bsky block of a device-blocked sender changes nothing.
     * `unblock` removes the marker whoever set it.
     */
    block(key: PairMailboxKey, nowSeconds: number, source?: BlockSource): Promise<void>

    /**
     * Mirror the owner's current Bsky blocks: block (`bsky`) every sender in
     * `blocked` the relay holds a mailbox or pool entry for. Never lifts a
     * marker: absence from `blocked` proves nothing. Walks the relay's own keys,
     * not `blocked`, so the cost follows what the relay holds rather than how
     * many the owner blocks.
     */
    syncBskyBlocks(blocked: ReadonlySet<string>): Promise<void>

    /** The senders whose block marker mirrors a Bsky block — a subset of `listBlocked`. */
    listBskyBlocked(): Promise<string[]>

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
