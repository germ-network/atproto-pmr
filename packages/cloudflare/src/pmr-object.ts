import { DurableObject } from "cloudflare:workers"
import {
    DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR,
    drainBacklog,
    encodeCapabilitiesFrame,
    handleAckFrame,
    parseGrantLifecycle,
    parseServedFunctions,
    type AppendResult,
    type EffectiveCapabilities,
    type GrantLifecycle,
    type GrantSummary,
    type MailboxKey,
    type MailboxSnapshot,
    type MessageId,
    type MessageRef,
    type Nonce,
    type OpenMailboxesPage,
    type PMRStore,
    type PoolSender,
    type PoolAppendResult,
    type RegistrationFields,
    type ServedFunction,
    type SyntheticBehavior,
    type SyntheticState,
} from "@germ-network/atproto-pmr-core"
import { kvBodyStore } from "./directory"
import type { PMREnv } from "./env"

/**
 * One Durable Object per relay — the per-PMR store from
 * `spec/storage-consistency.md`, implementing `PMRStore`.
 *
 * The object boundary is also the tenancy boundary: co-hosted relays share
 * only the directory, so isolation is structural rather than enforced by
 * query discipline. That is one of the guarantees this backend supplies for
 * free; the others are serialized append, atomic read-modify-write,
 * per-tenant alarms, and a storage-unit identity that *is* the locator.
 *
 * Where a method leans on one of those it says so — the point of the
 * `PMRStore` seam is that relay logic never assumes them.
 */

const KEY_REGISTRATION = "reg"
const KEY_POOL_BYTES = "poolBytes"

/**
 * The key families. A `MailboxKey` is the counterpart DID, so a prefixed
 * listing is also the DID listing — there is no side table mapping keys
 * back, and no way for one to disagree with the family it describes.
 *
 * DIDs contain `:` themselves, which is harmless: every read slices a fixed
 * prefix length rather than splitting, so `pool:did:plc:alice` recovers
 * `did:plc:alice` exactly.
 */
const POOL_PREFIX = "pool:"
const SYNTHETIC_PREFIX = "syn:"
const GRANT_PREFIX = "grant:"
const MAILBOX_PREFIX = "mbox:"

const mailboxKey = (k: MailboxKey) => `${MAILBOX_PREFIX}${k}`
const syntheticKey = (k: MailboxKey) => `${SYNTHETIC_PREFIX}${k}`
const discardKey = (k: MailboxKey) => `discard:${k}`
const poolKey = (k: MailboxKey) => `${POOL_PREFIX}${k}`
const nonceSetKey = (k: MailboxKey) => `nonces:${k}`
const retryHintKey = (k: MailboxKey) => `retry:${k}`
const grantKey = (address: string) => `${GRANT_PREFIX}${address}`

interface GrantRow {
    address: string
    expiresAt: number
    closed: boolean
}

/**
 * How many recently-accepted nonces a mailbox key remembers.
 *
 * The specification requires a recipient to record seen nonces per sender
 * "until a session with that sender supersedes the handshake". Until a
 * deployment has a session layer that can signal supersession, a bounded
 * most-recent window is the defensible stand-in.
 *
 * Note what an attacker cannot do with this bound: entries are recorded
 * only on an accepted outcome, which requires a valid signature from that
 * sender, and the set is keyed per sender — so a third party cannot evict a
 * victim's nonces to make room for replaying a captured envelope. The
 * residual is narrow: a sender replaying their *own* very old envelope
 * after legitimately sending this many fresher ones.
 */
const NONCE_SEEN_SET_SIZE = 256

const nonceHex = (n: Nonce) =>
    [...n].map((b) => b.toString(16).padStart(2, "0")).join("")

export class PMRObject extends DurableObject<PMREnv> implements PMRStore {
    private readonly db: DurableObjectStorage
    /**
     * Supplied by the deployment. The default is development-only and says
     * so; a production relay passes its own and does not publish it.
     */
    protected synthetic: SyntheticBehavior = DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR

    constructor(ctx: DurableObjectState, env: PMREnv) {
        super(ctx, env)
        this.db = ctx.storage
    }

    private capacity(): number {
        return parseInt(this.env.MAX_MESSAGES_PER_PAIR_SENDER)
    }

    /**
     * What this deployment serves **for this registration**.
     *
     * The deployment-wide part comes from config; the one per-registration
     * refinement is the `grant` drain, which ends when *this* registration's
     * last grant expires rather than on a deployment-wide schedule. A
     * deployment can therefore be `draining` while a client that holds no
     * live grants is correctly told `absent`.
     */
    private async effectiveCapabilities(): Promise<EffectiveCapabilities> {
        // Parsed rather than read loosely: an unrecognized identifier is a
        // misconfiguration that would otherwise yield a deployment serving
        // something it tells every client it does not.
        const declared = new Set(parseServedFunctions(this.env.CAPABILITIES))
        const on = (c: ServedFunction): "active" | "absent" =>
            declared.has(c) ? "active" : "absent"

        let grant: GrantLifecycle = declared.has("grant")
            ? parseGrantLifecycle(this.env.GRANT_LIFECYCLE)
            : "absent"
        if (grant === "draining") {
            const nowSeconds = Math.floor(Date.now() / 1000)
            const live = (await this.listGrants()).some(
                (g) => g.expiresAt > nowSeconds
            )
            if (!live) grant = "absent"
        }

        return {
            pairMailbox: on("pairMailbox"),
            grant,
            watch: on("watch"),
            observation: on("observation"),
        }
    }

    /**
     * Push a fresh `#capabilities` frame to every attached connection.
     *
     * Called where this object can *cause* a transition. Only one exists:
     * invalidating the last live grant during a drain ends that drain for
     * this registration. Two other transitions are deliberately not
     * covered, and neither needs to be:
     *
     * - **Deployment policy changing** (`GRANT_LIFECYCLE` edited) requires
     *   a redeploy, which drops every socket; clients reconnect and are
     *   told on connect.
     * - **A grant lapsing passively** wakes nothing here, so it is observed
     *   on the client's next connect. This is why the specification says a
     *   relay SHOULD re-send on change rather than MUST, and why a client
     *   must not treat the absence of a frame as proof nothing moved.
     */
    private async broadcastCapabilities(): Promise<void> {
        const sockets = this.ctx.getWebSockets()
        if (sockets.length === 0) return
        const frame = encodeCapabilitiesFrame(await this.effectiveCapabilities())
        for (const ws of sockets) ws.send(frame)
    }

    // MARK: - The events socket

    /**
     * `GET /pmr/v1/events` reaches this DO already authenticated — the
     * router verifies the RFC 9421 signature over the upgrade request
     * before ever forwarding it here, the same as every other owner
     * endpoint. This method does no authentication of its own; it only
     * ever runs for an owner who has already proven possession of the
     * anchor key.
     *
     * Hibernation, not germ-service's non-hibernating `webSocket.accept()`
     * + `addEventListener` style: this connection is long-lived and mostly
     * idle on mobile — exactly hibernation's case — and a non-hibernating
     * DO stays resident and billed for the whole connection regardless.
     * The cost is that per-connection state cannot live in an in-memory
     * array; it has to survive eviction. Nothing here needs any: draining
     * reads straight from durable storage, and an ack names its own
     * mailbox key and messageId, so there is nothing to carry in a
     * `serializeAttachment` payload either.
     */
    async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket upgrade", {
                status: 426,
            })
        }
        const [client, server] = Object.values(new WebSocketPair())
        this.ctx.acceptWebSocket(server)

        const capabilities = await this.effectiveCapabilities()

        // Deferred past the 101 response, matching this codebase's
        // "respond first, defer the rest" discipline elsewhere: the client
        // is connected the instant the handshake completes, with backlog
        // frames streaming in shortly after, rather than waiting for the
        // whole backlog to be computed before the socket even opens.
        this.ctx.waitUntil(
            drainBacklog(
                { store: this, bodies: kvBodyStore(this.env) },
                capabilities,
                (frame) => server.send(frame)
            )
        )

        return new Response(null, { status: 101, webSocket: client })
    }

    /**
     * A hibernation-woken instance reaches this with no surviving
     * in-memory context from `fetch` — everything it needs is in the
     * frame itself, which is exactly why an ack names its own mailbox key
     * and messageId rather than relying on anything remembered per
     * connection.
     *
     * `webSocketClose`/`webSocketError` are deliberately not implemented:
     * there is no in-memory session state to release, so there is nothing
     * for either to do.
     */
    async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer
    ): Promise<void> {
        if (typeof message === "string") return // frames are binary only
        try {
            await handleAckFrame(
                { store: this, bodies: kvBodyStore(this.env) },
                new Uint8Array(message)
            )
        } catch {
            // Malformed inbound frame: dropped, not fatal. There is no
            // owner-facing "you sent something bad" channel here, and
            // tearing down a long-lived mobile connection over one bad
            // frame is worse than silently ignoring it.
        }
    }

    // MARK: - Registration state

    async load(): Promise<RegistrationFields | null> {
        return (await this.db.get<RegistrationFields>(KEY_REGISTRATION)) ?? null
    }

    async update(fields: Partial<RegistrationFields>): Promise<void> {
        const current = await this.load()
        await this.db.put(KEY_REGISTRATION, { ...current, ...fields })
    }

    // MARK: - Pair mailboxes

    /**
     * Appends to a provisioned pair mailbox, or advances the synthetic
     * mailbox if the sender is blocked. The caller cannot tell which
     * happened, and neither can the sender.
     *
     * **Atomicity** (contract 1, and contract 7 for the nonce) comes from
     * single-threaded execution plus the runtime's input gate around
     * storage operations: no other request to this instance is processed
     * while a storage call from this method is outstanding, so the nonce
     * check, the append, and the nonce record cannot interleave with a
     * concurrent call for the same mailbox. A relational adapter needs a
     * transaction or a row lock here, and should key rows per mailbox
     * rather than rewriting a whole per-sender map.
     *
     * **Timing parity is load-bearing.** Both paths take this same round
     * trip and return through the same code; neither returns early. The
     * synthetic path is cheap in *storage* — no bytes, no queue rows —
     * never in *latency*. Body writes and delivery are deferred past the
     * response by the caller on both paths, so the extra work the real path
     * does is off the response path entirely.
     *
     * **Anti-replay** (contract 7). The nonce is checked once, before
     * dispatching, so both paths are covered by construction rather than by
     * remembering to duplicate the check. Only an accepted outcome records
     * it — a refusal does not, so a legitimate retry after `429` is
     * evaluated fresh once room exists.
     */
    async append(
        key: MailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number
    ): Promise<AppendResult> {
        const seen = await this.loadNonces(key)
        if (seen.includes(nonceHex(nonce))) {
            return { outcome: "duplicate" }
        }

        const blocked = await this.db.get<SyntheticState>(syntheticKey(key))
        const result =
            blocked !== undefined
                ? await this.advanceSynthetic(key, blocked, nowSeconds)
                : await this.appendReal(key, ref, nowSeconds)

        if (result.outcome === "appended") {
            await this.recordNonce(key, nonce, seen)
        }
        return result
    }

    private async appendReal(
        key: MailboxKey,
        ref: MessageRef,
        nowSeconds: number
    ): Promise<AppendResult> {
        const queue = (await this.db.get<MessageRef[]>(mailboxKey(key))) ?? []

        // Refuses at capacity — never accept-and-evict. Drop-oldest would
        // discard a message the sender was told had been accepted. The
        // recipient keeps the OLDEST messages from a flooding sender, which
        // is correct because first contact is what these mailboxes are for.
        if (queue.length >= this.capacity()) {
            return {
                outcome: "refused",
                // Same source the synthetic path uses. Two distributions
                // here would let a single 429 reveal which population a
                // sender is in — see SyntheticBehavior, requirement 4.
                retryAfter: await this.retryInstant(key, nowSeconds),
            }
        }

        queue.push(ref)
        await this.db.put(mailboxKey(key), queue)
        return { outcome: "appended", persistBody: true }
    }

    /**
     * No bytes, no queue rows, no delivery — and `persistBody: false`,
     * which is how the caller keeps "no bytes stored for a blocked sender"
     * true without ever learning it is talking to the synthetic path.
     */
    private async advanceSynthetic(
        key: MailboxKey,
        stored: SyntheticState,
        nowSeconds: number
    ): Promise<AppendResult> {
        const retryInstant = await this.retryInstant(key, nowSeconds)
        const { state, accepted } = this.synthetic.advance(
            stored,
            nowSeconds,
            this.capacity(),
            retryInstant
        )
        await this.db.put(syntheticKey(key), state)

        return accepted
            ? { outcome: "appended", persistBody: false }
            : { outcome: "refused", retryAfter: retryInstant }
    }

    /** Stable until it passes — see SyntheticBehavior, requirement 5. */
    private async retryInstant(
        key: MailboxKey,
        nowSeconds: number
    ): Promise<number> {
        const stored = await this.db.get<number>(retryHintKey(key))
        const next = this.synthetic.nextRetryInstant(stored, nowSeconds)
        if (next !== stored) {
            await this.db.put(retryHintKey(key), next)
        }
        return next
    }

    private async loadNonces(key: MailboxKey): Promise<string[]> {
        return (await this.db.get<string[]>(nonceSetKey(key))) ?? []
    }

    private async recordNonce(
        key: MailboxKey,
        nonce: Nonce,
        current: string[]
    ): Promise<void> {
        const updated = [...current, nonceHex(nonce)]
        while (updated.length > NONCE_SEEN_SET_SIZE) updated.shift()
        await this.db.put(nonceSetKey(key), updated)
    }

    async list(key: MailboxKey, limit: number): Promise<MessageRef[]> {
        const queue = (await this.db.get<MessageRef[]>(mailboxKey(key))) ?? []
        return queue.slice(0, limit)
    }

    /** Idempotent: the client's ack path retries (contract 6). */
    async remove(key: MailboxKey, messageId: MessageId): Promise<void> {
        const queue = await this.db.get<MessageRef[]>(mailboxKey(key))
        if (queue === undefined) return
        const remaining = queue.filter((r) => r.messageId !== messageId)
        if (remaining.length === queue.length) return
        await this.db.put(mailboxKey(key), remaining)
    }

    async hasMailbox(key: MailboxKey): Promise<boolean> {
        if ((await this.db.get(mailboxKey(key))) !== undefined) return true
        return (await this.db.get(syntheticKey(key))) !== undefined
    }

    /**
     * Reconnect-drain's primitive. `startAfter` gives cursor semantics for
     * free from the underlying storage — `nextCursor` is just the last raw
     * key on this page, independent of how many entries survived the
     * empty-queue filter, so a page that filters down to nothing still
     * advances.
     *
     * Fetches `limit + 1` and trims: fetching exactly `limit` cannot tell
     * "there are more" from "that was all of them", since both return a
     * full page.
     */
    async openMailboxes(
        cursor: string | null,
        limit: number
    ): Promise<OpenMailboxesPage> {
        const raw = await this.db.list<MessageRef[]>({
            prefix: MAILBOX_PREFIX,
            startAfter: cursor ?? undefined,
            limit: limit + 1,
        })
        const rows = [...raw].slice(0, limit)
        const hasMore = raw.size > limit

        const entries: MailboxSnapshot[] = []
        for (const [k, messages] of rows) {
            if (messages.length === 0) continue
            entries.push({ key: k.slice(MAILBOX_PREFIX.length), messages })
        }
        return {
            entries,
            nextCursor: hasMore ? rows[rows.length - 1][0] : null,
        }
    }

    // MARK: - The recovery pool

    /**
     * Shallow per sender, wide in sender count, newest-wins on overflow —
     * the inverse of a provisioned mailbox, because a recovery attempt is
     * not a thread and the freshest attempt carries current state.
     *
     * Under pressure **depth gives and width holds**: the bound is bytes
     * rather than sender count, since width is the property the pool exists
     * to provide. Only at true exhaustion is a sender not already present
     * turned away.
     *
     * **The discard check runs here, not in the caller.** A caller that
     * checks discard status separately and skips this call for a discarded
     * sender makes discard observable by round-trip count and timing even
     * though the response bytes are identical. Folding it in means exactly
     * one call either way, with the discarded branch doing the same reads
     * before skipping only the write.
     *
     * **Anti-replay** shares its nonce set with `append` for the same key,
     * deliberately: a nonce is a property of the (sender, envelope) pair,
     * not of which tier absorbed it. Otherwise a sender provisioned
     * mid-flight could replay a pooled envelope into their new mailbox.
     */
    async appendToPool(
        key: MailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number
    ): Promise<PoolAppendResult> {
        const seen = await this.loadNonces(key)
        if (seen.includes(nonceHex(nonce))) {
            return { outcome: "duplicate" }
        }

        const discardedUntil = await this.db.get<number>(discardKey(key))
        const discarded =
            discardedUntil !== undefined && discardedUntil > nowSeconds

        const capBytes = parseInt(this.env.POOL_CAP_BYTES)
        const depth = parseInt(this.env.POOL_DEPTH_PER_SENDER)
        const depthUnderPressure = parseInt(this.env.POOL_DEPTH_UNDER_PRESSURE)

        const usedBytes = (await this.db.get<number>(KEY_POOL_BYTES)) ?? 0
        const underPressure = usedBytes >= capBytes
        const effectiveDepth = underPressure ? depthUnderPressure : depth

        const existing = (await this.db.get<MessageRef[]>(poolKey(key))) ?? []

        if (discarded) {
            // Nothing kept and no nonce recorded, so a fresh attempt once
            // the window lapses is evaluated on its own terms — the same
            // reasoning `append`'s refusal relies on.
            return { outcome: "pooled", persistBody: false }
        }

        if (existing.length === 0 && underPressure) {
            return { outcome: "exhausted" }
        }

        existing.push(ref)
        let reclaimed = 0
        while (existing.length > effectiveDepth) {
            const evicted = existing.shift()
            if (evicted !== undefined) reclaimed += evicted.byteLength
        }

        await this.db.put(poolKey(key), existing)
        await this.db.put(KEY_POOL_BYTES, usedBytes + ref.byteLength - reclaimed)
        await this.recordNonce(key, nonce, seen)
        return { outcome: "pooled", persistBody: true }
    }

    /**
     * DIDs only, never bodies.
     *
     * A projection of the pool's own keys — not a join. Because the key is
     * the DID, there is no entry whose DID can go missing and leave the
     * sender unadjudicable until retention expiry.
     */
    async poolSenders(): Promise<PoolSender[]> {
        const entries = await this.db.list<MessageRef[]>({ prefix: POOL_PREFIX })
        return [...entries].map(([k, refs]) => ({
            did: k.slice(POOL_PREFIX.length),
            count: refs.length,
        }))
    }

    /**
     * Move a pooled sender's entries into a real pair mailbox.
     *
     * Capacity is applied on the way in, so provisioning a sender who
     * flooded the pool cannot overfill their new mailbox — and the entries
     * kept are the OLDEST, matching what a provisioned mailbox does under
     * pressure. The pool's own newest-wins policy governed which attempts
     * survived to be provisioned; it does not follow them across.
     */
    async provisionFromPool(
        key: MailboxKey,
        _nowSeconds: number
    ): Promise<MessageRef[]> {
        // A blocked sender is never provisionable. `block` already purges
        // the pool, so this is belt-and-braces against a future caller that
        // reaches here with a stale key — provisioning a blocked sender
        // would undo the block by creating them a live mailbox.
        if ((await this.db.get(syntheticKey(key))) !== undefined) return []

        const pooled = (await this.db.get<MessageRef[]>(poolKey(key))) ?? []
        if (pooled.length === 0) {
            // Provisioning an empty sender still creates the mailbox, so
            // their next put lands normally rather than pooling again.
            const existing = await this.db.get<MessageRef[]>(mailboxKey(key))
            if (existing === undefined) await this.db.put(mailboxKey(key), [])
            return []
        }

        const queue = (await this.db.get<MessageRef[]>(mailboxKey(key))) ?? []
        const room = Math.max(0, this.capacity() - queue.length)
        const moved = pooled.slice(0, room)

        await this.db.put(mailboxKey(key), [...queue, ...moved])
        await this.releasePool(key, pooled)
        return moved
    }

    /** Drop the pooled entries and suppress the sender until `until`. */
    async discardFromPool(key: MailboxKey, until: number): Promise<void> {
        const pooled = (await this.db.get<MessageRef[]>(poolKey(key))) ?? []
        await this.releasePool(key, pooled)
        await this.db.put(discardKey(key), until)
    }

    /** Remove a sender's pool entries and return their bytes to the budget. */
    private async releasePool(
        key: MailboxKey,
        pooled: MessageRef[]
    ): Promise<void> {
        const freed = pooled.reduce((n, r) => n + r.byteLength, 0)
        const used = (await this.db.get<number>(KEY_POOL_BYTES)) ?? 0
        await this.db.delete(poolKey(key))
        await this.db.put(KEY_POOL_BYTES, Math.max(0, used - freed))
    }

    // MARK: - Blocking and discard

    async block(key: MailboxKey, _nowSeconds: number): Promise<void> {
        if ((await this.db.get(syntheticKey(key))) !== undefined) return

        // An empty state is the blocked marker. Deliberately NOT seeded by
        // calling `advance` — that would count a fill at block time, so the
        // sender's first subsequent put would land one slot further along
        // than a real mailbox's, which is a distinguisher. `advance`
        // receives this empty object on the first put and initializes.
        await this.db.put(syntheticKey(key), {} satisfies SyntheticState)

        // Dropping the queue is the point, not a side effect: no bytes are
        // kept for a blocked sender.
        await this.db.delete(mailboxKey(key))

        // And the pool, for the same reason. A sender who was pooled and
        // then blocked would otherwise still surface in the owner's pool
        // listing, and adjudication could provision them — creating a live
        // mailbox holding a blocked sender's messages. Releasing through
        // the shared helper also returns their bytes to the pool budget.
        const pooled = (await this.db.get<MessageRef[]>(poolKey(key))) ?? []
        if (pooled.length > 0) await this.releasePool(key, pooled)
    }

    async unblock(key: MailboxKey): Promise<void> {
        await this.db.delete(syntheticKey(key))
    }

    /** The block markers' own keys — the DIDs. No second table to drift. */
    async listBlocked(): Promise<string[]> {
        const entries = await this.db.list<SyntheticState>({
            prefix: SYNTHETIC_PREFIX,
        })
        return [...entries.keys()].map((k) => k.slice(SYNTHETIC_PREFIX.length))
    }

    async setDiscarded(key: MailboxKey, until: number): Promise<void> {
        await this.db.put(discardKey(key), until)
    }

    /**
     * For owner-facing queries only — never the put path.
     *
     * A put must NOT branch on this: `appendToPool` checks discard status
     * internally so that a discarded sender costs the same round trip a
     * pooled one does. Calling this first and skipping the append would
     * reintroduce exactly the timing oracle that folding it in removed.
     *
     * Expiry is an observability rule, so a lapsed window reads as absent
     * even before anything reclaims it.
     */
    async isDiscarded(key: MailboxKey, nowSeconds: number): Promise<boolean> {
        const until = await this.db.get<number>(discardKey(key))
        return until !== undefined && until > nowSeconds
    }

    // MARK: - Grants

    /**
     * The owner's own record of a grant they issued. `authKey` is
     * deliberately not a parameter of what gets stored here — the
     * Directory's routing row is the only place a put needs to find it,
     * and this record exists to answer "is this address mine" and "what
     * have I issued", neither of which needs the secret itself.
     */
    async issueGrant(
        address: string,
        _authKey: Uint8Array,
        expiresAt: number
    ): Promise<void> {
        await this.db.put(grantKey(address), {
            address,
            expiresAt,
            closed: false,
        } satisfies GrantRow)
    }

    async listGrants(): Promise<GrantSummary[]> {
        const entries = await this.db.list<GrantRow>({ prefix: GRANT_PREFIX })
        return [...entries.values()]
    }

    async getGrant(address: string): Promise<GrantSummary | null> {
        return (await this.db.get<GrantRow>(grantKey(address))) ?? null
    }

    /** A no-op if `address` was never issued by this owner. */
    async setGrantClosed(address: string, closed: boolean): Promise<void> {
        const row = await this.db.get<GrantRow>(grantKey(address))
        if (row === undefined) return
        await this.db.put(grantKey(address), { ...row, closed })
    }

    async invalidateGrant(address: string): Promise<void> {
        await this.db.delete(grantKey(address))
        // May have been the last live grant of a drain, which ends it for
        // this registration — the one capability transition this object
        // can cause rather than merely observe.
        await this.broadcastCapabilities()
    }
}
