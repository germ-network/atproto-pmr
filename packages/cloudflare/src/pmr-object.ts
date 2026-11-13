import { DurableObject } from "cloudflare:workers"
import {
    DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR,
    INITIAL_WATCH_STATE,
    buildMessagePushPayload,
    compareRev,
    drainBacklog,
    encodeCapabilitiesFrame,
    encodeDeliveryFrame,
    encodeSummaryFrame,
    handleAckFrame,
    isPairMailboxKey,
    parseGrantLifecycle,
    reconcileWatchState,
    type AppendResult,
    type Admission,
    type BlockSource,
    type ReceiveResult,
    type PairMailboxKey,
    type PairAppendResult,
    type PairMailboxEvidence,
    type StoredPairMailboxEvidence,
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
    type RegistrationFields,
    type RequestAppendResult,
    type RequestMailbox,
    type RequestMailboxesPage,
    SUMMARY_TOKENS_KEPT,
    type SummaryIndex,
    type SyntheticBehavior,
    type SyntheticState,
    type WatchOutcome,
    type WatchState,
} from "@germ-network/atproto-pmr-core"
import { kvBodyStore } from "./directory"
import type { PMREnv } from "./env"
import { monitorOwnBlocks } from "./monitor-own-blocks"
import { webPushSender } from "./push-sender"
import { errorKind } from "./log-safe"

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
/** Bytes held across every request mailbox: entries and, once accounted, their proofs. */
const KEY_REQUEST_BYTES = "reqBytes"
/** Used when `REQUEST_DEPTH_PER_SENDER` or `REQUEST_SHARED_CAP_BYTES` is unset or not a positive integer. */
const DEFAULT_REQUEST_DEPTH_PER_SENDER = 5
const DEFAULT_REQUEST_SHARED_CAP_BYTES = 5_000_000
/** When the next sweep of request entries whose bodies have expired is due, in seconds. */
const KEY_REQUEST_SWEEP_AT = "reqSweepAt"
const KEY_REQUEST_SWEEP_CURSOR = "reqSweepCursor"
const REQUEST_SWEEP_INTERVAL_SECONDS = 86_400
const REQUEST_SWEEP_BATCH_SIZE = 50
/**
 * A request entry's body is written after its put is answered, and the body
 * store is eventually consistent, so an entry is judged by its body only once
 * it is older than this.
 */
const REQUEST_BODY_GRACE_SECONDS = 300
const requestJudgementCutoff = () => Math.floor(Date.now() / 1000) - REQUEST_BODY_GRACE_SECONDS
const KEY_PAIR_EVIDENCE_EXPIRY_CURSOR = "pairEvidenceExpiryCursor"
const KEY_PAIR_EVIDENCE_EXPIRY_MIN = "pairEvidenceExpiryMin"
const PAIR_EVIDENCE_EXPIRY_BATCH_SIZE = 100
/** The own-DID declaration watch's `WatchState` (`watch.ts`). */
const KEY_WATCH = "watch"
const KEY_MONITOR_CONFIRMED = "monitorConfirmed"

/** One served summary state per entry, so storing one never rewrites another. */
const SUMMARY_PREFIX = "summary:"
const summaryKey = (token: string) => SUMMARY_PREFIX + token
/** Which served states are held, oldest first; small, so a put never reads an index's parts. */
const KEY_SUMMARY_ORDER = "summaryOrder"

/**
 * An index is stored as a header under `summaryKey` and the owner's
 * blocks, the record entries and the verdicts in parts under `summaryPartKey`, each part far below the 2 MB value
 * limit however many blocks or contacts the owner has. A distinct prefix keeps a
 * client-named token from addressing a part.
 */
const SUMMARY_PART_PREFIX = "summaryPart:"
const summaryPartKey = (token: string, index: number) => `${SUMMARY_PART_PREFIX}${token}:${index}`
/** Serialized characters per part: half the value limit, since a DID may run to 2 KiB. */
const SUMMARY_PART_CHARS = 1_000_000
/** Keys one storage `get`, `put` or `delete` accepts. */
const STORAGE_BATCH = 128

interface SummaryHeader {
    owner: string
    more?: boolean
    evidenceSchema?: number
    permissionRecencySchema?: number
    parts: number
}

interface SummaryPart {
    field: "ownBlocks" | "records" | "verdicts"
    items: unknown[]
}
interface SummaryOrder {
    token: string
    order: number
}
/** Durable Object storage rejects a key longer than 2 KiB. */
const MAX_KEY_BYTES = 2048

/*
 * The key families — which *kind of record* this is, an axis orthogonal to
 * the `MailboxKey` it is about. A prefixed listing is therefore also the
 * key listing, with no side table to disagree with the family it describes.
 *
 * Keys contain `:` themselves — a DID always, and a grant key by its own
 * prefix — which is harmless: every read slices a fixed prefix length
 * rather than splitting, so `req:did:plc:alice` recovers `did:plc:alice`
 * and `mbox:grant:abc` recovers `grant:abc`, both exactly.
 *
 * `GRANT_ROW_PREFIX` is NOT the wire-level `grant:` mailbox-kind prefix,
 * despite the near-collision: this one names an owner's record OF a grant
 * they issued, keyed by bare address, while that one makes a routing key
 * out of an address. A grant's queue lives under `mbox:grant:<address>`
 * and its metadata under `grantrow:<address>`.
 */
/** A sender's request mailbox: a non-empty `MessageRef[]`, deleted when it empties. */
const REQUEST_PREFIX = "req:"
const SYNTHETIC_PREFIX = "syn:"
const GRANT_ROW_PREFIX = "grantrow:"
const MAILBOX_PREFIX = "mbox:"
const PAIR_EVIDENCE_PREFIX = "pairEvidence:"
/** Marks a relay block (`syn:`) that mirrors a Bsky block, so a device takeover or unblock can tell it from a device block. */
const BSKY_BLOCK_PREFIX = "bsky:"

const mailboxKey = (k: MailboxKey) => `${MAILBOX_PREFIX}${k}`
const syntheticKey = (k: MailboxKey) => `${SYNTHETIC_PREFIX}${k}`
const requestKey = (k: MailboxKey) => `${REQUEST_PREFIX}${k}`
const bskyBlockKey = (k: MailboxKey) => `${BSKY_BLOCK_PREFIX}${k}`
const nonceSetKey = (k: MailboxKey) => `nonces:${k}`
const retryHintKey = (k: MailboxKey) => `retry:${k}`
const pairEvidenceKey = (k: MailboxKey) => `${PAIR_EVIDENCE_PREFIX}${k}`
const grantRowKey = (address: string) => `${GRANT_ROW_PREFIX}${address}`

interface GrantRow {
    address: string
    expiresAt: number
    closed: boolean
}

type StoredPairEvidence = StoredPairMailboxEvidence & {
    /** Latest independently verified declaration, distinct from the selected
     * proof kept across same-key edits. Optional for pre-patch rows. */
    watermark?: Pick<PairMailboxEvidence, "revision" | "declarationCID" | "anchorKey">
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
const MAX_PAIR_EVIDENCE_BYTES = 1_000_000

/** What `judgeRequestSweep` decided before the object was held. */
interface RequestSweepPass {
    /** Absent when no sweep is armed. */
    dueAt: number | undefined
    /** Present when the sweep is due now. */
    senders?: Array<{ key: MailboxKey; dead: Set<MessageId> }>
    full?: boolean
}

/** A request entry as stored: the ref plus when this object held it. */
type HeldRef = MessageRef & { heldAt?: number }

const unheld = (ref: HeldRef): MessageRef => {
    const { heldAt: _heldAt, ...bare } = ref
    return bare
}

/** A tunable that is missing or malformed must not unbound the tier it limits. */
function positiveInteger(raw: string | undefined, fallback: number): number {
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

const nonceHex = (n: Nonce) =>
    [...n].map((b) => b.toString(16).padStart(2, "0")).join("")

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false
    let diff = 0
    for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
    return diff === 0
}

/** For logging: the push-service host, never the full capability URL. */
const safeOrigin = (endpoint: string): string => {
    try {
        return new URL(endpoint).origin
    } catch {
        return "<unparseable endpoint>"
    }
}

export class PMRObject extends DurableObject<PMREnv> implements PMRStore {
    private readonly db: DurableObjectStorage
    /**
     * Supplied by the deployment. The default is development-only and says
     * so; a production relay passes its own and does not publish it.
     */
    protected synthetic: SyntheticBehavior = DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR
    /** The shortest gap between two `#summary` frames; see `nudgeSummary`. */
    protected summaryNudgeIntervalMs = 1000
    private lastSummaryNudgeAtMs = 0
    private summaryTrailingPending = false

    constructor(ctx: DurableObjectState, env: PMREnv) {
        super(ctx, env)
        this.db = ctx.storage
    }

    private capacity(): number {
        return parseInt(this.env.MAX_MESSAGES_PER_PAIR_SENDER)
    }

    private requestDepth(): number {
        return positiveInteger(this.env.REQUEST_DEPTH_PER_SENDER, DEFAULT_REQUEST_DEPTH_PER_SENDER)
    }

    private requestCapBytes(): number {
        return positiveInteger(this.env.REQUEST_SHARED_CAP_BYTES, DEFAULT_REQUEST_SHARED_CAP_BYTES)
    }

    /**
     * What this deployment serves **for this registration**.
     *
     * The deployment-wide part comes from config; the one per-registration
     * refinement is the grant drain, which ends when *this* registration's
     * last grant expires rather than on a deployment-wide schedule. A
     * deployment can therefore be `draining` while a client that holds no
     * live grants is correctly told `absent`.
     *
     * `fetch()` relies on this method's only await (`listGrants`, below)
     * being a DO *storage* read: that keeps the input gate closed for the
     * duration, so a concurrent `deliverLive` RPC cannot land on the new
     * socket before `#capabilities` does. Adding a non-storage await here
     * (a `fetch()` call, a timer) would reopen that race — don't.
     */
    private async effectiveCapabilities(): Promise<EffectiveCapabilities> {
        // Parsed rather than read loosely: an unrecognized value is a
        // misconfiguration, and a relay that puts one on the wire tells
        // every client something it cannot act on.
        let grant: GrantLifecycle = parseGrantLifecycle(
            this.env.GRANT_LIFECYCLE
        )
        if (grant === "draining") {
            const nowSeconds = Math.floor(Date.now() / 1000)
            const live = (await this.listGrants()).some(
                (g) => g.expiresAt > nowSeconds
            )
            if (!live) grant = "absent"
        }

        return { grant, pairGeneration: true }
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
        this.broadcast(encodeCapabilitiesFrame(await this.effectiveCapabilities()))
    }

    /**
     * Fan out one frame to every attached connection.
     *
     * Every socket on this object belongs to THIS registration — the router
     * resolves the stub from the authenticated DID — so there is no
     * per-socket routing to do and no tag to filter on: an owner's devices
     * all receive an owner's mail. Same reasoning `drainBacklog` already
     * relies on.
     *
     * A send to a socket the peer dropped can throw; that is not the
     * caller's problem, and letting it propagate would fail an owner
     * request (or a deferred put) over a connection that is already gone.
     */
    private broadcast(frame: Uint8Array): void {
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(frame)
            } catch {}
        }
    }

    /** `PMRStore.deliverLive` — see `storage.ts` for why the bytes are a parameter. */
    async deliverLive(
        key: MailboxKey,
        ref: MessageRef,
        message: Uint8Array
    ): Promise<void> {
        if (this.ctx.getWebSockets().length === 0) return
        this.broadcast(encodeDeliveryFrame(key, ref, message))
    }

    /**
     * Tell this owner's attached devices that their graph or summary inputs
     * may have changed (`#summary`). With nothing attached it returns at
     * once and sends nothing. Never throws: a nudge is a hint, and its
     * caller has nothing to do about a socket that is already gone.
     *
     * Nudges closer together than `summaryNudgeIntervalMs` coalesce: the
     * first goes out at once and the rest become one frame at the end of
     * the interval, so a burst costs a device at most two reads and the
     * last change in it is announced too. The interval and the pending
     * frame live in memory: hibernation resetting the interval costs at
     * most one extra frame, and an eviction inside the interval drops the
     * pending one.
     */
    async nudgeSummary(): Promise<void> {
        try {
            if (this.ctx.getWebSockets().length === 0) return
            const waitMs =
                this.lastSummaryNudgeAtMs + this.summaryNudgeIntervalMs - Date.now()
            if (waitMs <= 0) {
                this.sendSummary()
                return
            }
            if (this.summaryTrailingPending) return
            this.summaryTrailingPending = true
            // `fetch()` holds `#capabilities` first by keeping the input
            // gate closed across its storage await; that gate also holds
            // this callback, so it cannot reach a socket still being set up.
            setTimeout(() => {
                this.summaryTrailingPending = false
                try {
                    this.sendSummary()
                } catch (error) {
                    console.error("nudgeSummary trailing send failed", errorKind(error))
                }
            }, waitMs)
        } catch (error) {
            console.error("nudgeSummary failed", errorKind(error))
        }
    }

    private sendSummary(): void {
        this.lastSummaryNudgeAtMs = Date.now()
        this.broadcast(encodeSummaryFrame())
    }

    /**
     * `PMRStore.deliverPush` — Web Push, where this deployment delegates
     * it (`webPushSender` returns `null` and this no-ops otherwise).
     *
     * Loads the registration fresh rather than accepting it as a
     * parameter: unlike `deliverLive`, this doesn't run once per socket —
     * it needs the subscription, which lives on the registration, not on
     * anything the caller already holds.
     *
     * Unlike the bare interface contract ("a caller MUST treat a
     * rejection as nothing-happened"), THIS implementation never rejects:
     * every failure is caught and logged here rather than left to
     * whichever caller happens to be holding a `try/catch`. Without this,
     * a base-wide misconfiguration (a rotated VAPID key that no longer
     * pairs, an exhausted push-service quota) fails every delivery
     * silently forever — nothing server-side would ever show it. `failed`
     * and a thrown error are logged; `discard` (404/410) and `retry`
     * (429) are normal lifecycle, not logged as failures.
     *
     * Logs only the endpoint's origin, never the full capability URL —
     * the path carries an opaque token a log line has no reason to keep.
     */
    async deliverPush(
        key: MailboxKey,
        ref: MessageRef,
        message: Uint8Array
    ): Promise<void> {
        const reg = await this.load()
        if (reg?.pushSubscription === undefined) return
        const endpointOrigin = safeOrigin(reg.pushSubscription.endpoint)

        // The whole body is guarded, not just `sender.send()`: constructing
        // the sender itself decodes `VAPID_PRIVATE_KEY` eagerly
        // (`webPushSender` in push-sender.ts), so a malformed secret throws
        // right there — before any request is even attempted. That's the
        // same base-wide-misconfiguration class this logging exists to
        // catch, so it has to be inside the guard too.
        try {
            const sender = webPushSender(this.env)
            if (sender === null) return

            const plaintext = buildMessagePushPayload({
                key,
                ref,
                message,
                maxSealedBytes: sender.maxSealedBytes,
            })
            const result = await sender.send(reg.pushSubscription, plaintext)
            if (result.outcome === "discard") {
                await this.update({ pushSubscription: undefined })
            } else if (result.outcome === "failed") {
                console.error(
                    `deliverPush: push service answered ${result.status} for ${endpointOrigin}`
                )
            }
        } catch (err) {
            console.error(`deliverPush: failed for ${endpointOrigin}`, errorKind(err))
        }
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
                {
                    store: this,
                    bodies: kvBodyStore(this.env),
                    blocks: monitorOwnBlocks(this.env),
                },
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

    async touchActive(_nowSeconds: number, _anchorKey: Uint8Array): Promise<void> {
        throw new Error("not implemented")
    }

    async isMonitorConfirmed(): Promise<boolean> {
        return (await this.db.get<boolean>(KEY_MONITOR_CONFIRMED)) === true
    }

    async markMonitorConfirmed(): Promise<void> {
        await this.db.put(KEY_MONITOR_CONFIRMED, true)
    }

    // MARK: - The declaration watch

    async readWatchState(): Promise<WatchState> {
        return (await this.db.get<WatchState>(KEY_WATCH)) ?? INITIAL_WATCH_STATE
    }

    async writeWatchState(state: WatchState): Promise<void> {
        await this.db.put(KEY_WATCH, state)
    }

    /**
     * Read-modify-write of the recency list and the entries, atomic under the
     * Durable Object's input gate: nothing here awaits anything but storage.
     */
    async putSummaryIndex(
        token: string,
        index: SummaryIndex,
        servedAtMs: number,
        replaces?: string
    ): Promise<void> {
        const parts = splitSummaryIndex(index)
        await this.db.transaction(async (txn) => {
            const held = (await txn.get<SummaryOrder[]>(KEY_SUMMARY_ORDER)) ?? []
            // Recency is a strictly increasing order, so equal or regressing
            // clock readings cannot reorder what was served.
            const latest = held.reduce((max, e) => Math.max(max, e.order), 0)
            const kept = held.filter((e) => e.token !== token && e.token !== replaces)
            const next = [...kept, { token, order: Math.max(servedAtMs, latest + 1) }].sort(
                (a, b) => a.order - b.order
            )
            const dropped = next.slice(0, Math.max(0, next.length - SUMMARY_TOKENS_KEPT))
            const previous = await txn.get<SummaryHeader>(summaryKey(token))
            const entries: [string, unknown][] = [
                [
                    summaryKey(token),
                    {
                        owner: index.owner,
                        ...(index.more ? { more: true } : {}),
                        ...(index.evidenceSchema === undefined ? {} : { evidenceSchema: index.evidenceSchema }),
                        ...(index.permissionRecencySchema === undefined
                            ? {}
                            : { permissionRecencySchema: index.permissionRecencySchema }),
                        parts: parts.length,
                    } satisfies SummaryHeader,
                ],
                ...parts.map((part, i): [string, unknown] => [summaryPartKey(token, i), part]),
            ]
            for (const batch of chunk(entries, STORAGE_BATCH)) {
                await txn.put(Object.fromEntries(batch))
            }
            await txn.put(KEY_SUMMARY_ORDER, next.slice(dropped.length))

            const keys = previous ? summaryPartKeys(token, parts.length, previous.parts) : []
            const gone = dropped.map((e) => e.token)
            if (replaces !== undefined && replaces !== token) gone.push(replaces)
            for (const goneToken of gone) {
                const header = await txn.get<SummaryHeader>(summaryKey(goneToken))
                keys.push(summaryKey(goneToken), ...summaryPartKeys(goneToken, 0, header?.parts ?? 0))
            }
            for (const batch of chunk(keys, STORAGE_BATCH)) await txn.delete(batch)
        })
    }

    async getSummaryIndex(token: string): Promise<SummaryIndex | null> {
        // A client names the token, so one too long to be a key is simply not held.
        if (new TextEncoder().encode(summaryKey(token)).length > MAX_KEY_BYTES) return null
        const header = await this.db.get<SummaryHeader>(summaryKey(token))
        if (!header || typeof header.parts !== "number" || typeof header.owner !== "string") return null
        const index: SummaryIndex = {
            owner: header.owner,
            ownBlocks: [],
            records: [],
            verdicts: [],
            ...(header.more ? { more: true } : {}),
            ...(header.evidenceSchema === undefined ? {} : { evidenceSchema: header.evidenceSchema }),
            ...(header.permissionRecencySchema === undefined
                ? {}
                : { permissionRecencySchema: header.permissionRecencySchema }),
        }
        const keys = summaryPartKeys(token, 0, header.parts)
        for (const batch of chunk(keys, STORAGE_BATCH)) {
            const read = await this.db.get<SummaryPart>(batch)
            for (const key of batch) {
                const part = read.get(key)
                if (!part) return null
                if (part.field === "records") index.records.push(...(part.items as SummaryIndex["records"]))
                else if (part.field === "ownBlocks") {
                    index.ownBlocks.push(...(part.items as SummaryIndex["ownBlocks"]))
                } else if (part.field === "verdicts") {
                    index.verdicts.push(...(part.items as SummaryIndex["verdicts"]))
                }
            }
        }
        return index
    }

    /**
     * Fold one re-check outcome into the paused flag — the atomic
     * read-modify-write (`watch.ts`, `reconcileWatchState`), atomic here by
     * this object's single-threaded execution and storage input gate.
     *
     * The DRIVER lives outside this object and calls this: it does the
     * authoritative declaration re-fetch and classification itself, so no
     * network call happens here. In this deployment the driver is a
     * firehose-fed queue consumer (`GermMonitor` enqueues on a declaration
     * change; the Worker's `queue()` handler re-fetches and calls this); a
     * relational adopter would drive it from a cron + `dueForWork` sweep.
     * `unknown` only stamps the check and is a no-op on the flag — a driver
     * typically retries a transient rather than recording it.
     *
     * `observedRev` carries the monotonic-rev watermark (`reconcileWatchState`):
     * an outcome whose rev is not strictly newer than the stored one is refused.
     * The read-then-write stays atomic because `compareRev` is synchronous — no
     * await reopens this object's input gate between the read and the write.
     */
    async applyDeclarationOutcome(
        outcome: WatchOutcome,
        nowSeconds: number,
        observedRev?: string
    ): Promise<void> {
        const prev = await this.readWatchState()
        if (
            observedRev !== undefined &&
            compareRev(prev.lastObservedRev ?? null, observedRev) === "regressed"
        ) {
            // A rev that moved backwards is a rollback (or an equivocating PDS,
            // `spec/trust-model.md`). It is refused by the watermark below; log
            // it, since it is not an ordinary reorder.
            console.warn(
                "declaration recheck: observed rev regressed",
                `(stored ${prev.lastObservedRev}, observed ${observedRev}) — refusing`
            )
        }
        await this.writeWatchState(
            reconcileWatchState(prev, outcome, nowSeconds, observedRev)
        )
    }

    // MARK: - Pair mailboxes

    /**
     * Pair evidence, its generation and the accepted append share one
     * serialized operation. Unknown evidence never reaches this method: the
     * caller supplies only a declaration independently verified at ingest.
     */
    async appendPair(
        key: `did:${string}`,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        evidence: PairMailboxEvidence,
        admission?: Admission
    ): Promise<PairAppendResult> {
        // Reject malformed/unbounded proofs before entering the DO input gate;
        // exceptions inside blockConcurrencyWhile can reset the object.
        if (
            evidence === undefined || evidence.senderDID !== key ||
            !(evidence.anchorKey instanceof Uint8Array) || evidence.anchorKey.byteLength !== 32 ||
            !(evidence.car instanceof Uint8Array) || evidence.car.byteLength === 0 ||
            evidence.car.byteLength > MAX_PAIR_EVIDENCE_BYTES ||
            typeof evidence.revision !== "string" ||
            !/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(evidence.revision) ||
            !Number.isSafeInteger(evidence.expiresAt) || evidence.expiresAt <= nowSeconds
        ) return { generationChanged: false, recycledMessageIds: [], rejected: "invalidEvidence" }
        return this.ctx.blockConcurrencyWhile(async () => {
            const evidenceKey = pairEvidenceKey(key)
            const prior = await this.db.get<StoredPairEvidence>(evidenceKey)
            // Legacy rows have only the original tuple. Fall back to it
            // conservatively: never guess an equal-revision CID that an old
            // same-key edit failed to retain. A newer revision can recover.
            const watermark = prior?.watermark ?? prior
            if (watermark !== undefined && (
                evidence.revision < watermark.revision ||
                (evidence.revision === watermark.revision &&
                    (evidence.declarationCID !== watermark.declarationCID || !sameBytes(evidence.anchorKey, watermark.anchorKey)))
            )) return { generationChanged: false, recycledMessageIds: [], rejected: "staleEvidence" }

            const mailboxExisted = (await this.db.get<MessageRef[]>(mailboxKey(key))) !== undefined
            let selected: StoredPairEvidence
            let recycledMessageIds: MessageId[] = []
            let generationChanged = false
            if (prior === undefined) {
                selected = { ...evidence, car: new Uint8Array(), generation: crypto.randomUUID() }
                generationChanged = true
            } else if (!sameBytes(prior.anchorKey, evidence.anchorKey)) {
                const [queue, requests] = await Promise.all([
                    this.db.get<MessageRef[]>(mailboxKey(key)),
                    this.db.get<MessageRef[]>(requestKey(key)),
                ])
                recycledMessageIds = [...(queue ?? []), ...(requests ?? [])].map((r) => r.messageId)
                if (queue !== undefined) await this.db.put(mailboxKey(key), [])
                await this.releaseRequest(key)
                await this.db.delete(retryHintKey(key))
                selected = { ...evidence, car: new Uint8Array(), generation: crypto.randomUUID() }
                generationChanged = true
            } else {
                // A declaration edit is not a new mailbox generation. Retain
                // one selected proof rather than archiving each revision.
                selected = { ...prior }
            }
            if (selected.car.byteLength > 0 && selected.expiresAt <= nowSeconds) {
                await this.expireProof(key, mailboxExisted)
                selected = { ...selected, car: new Uint8Array(), requestAccountedBytes: 0 }
            }

            selected.watermark = {
                revision: evidence.revision,
                declarationCID: evidence.declarationCID,
                anchorKey: evidence.anchorKey,
            }

            // A request-only first contact gets a row only when its entry and
            // proof are held together (below). Existing floors, rotations and
            // pair mailboxes remain durable.
            if (prior !== undefined || mailboxExisted || admission?.verdict === "yes") {
                await this.db.put(evidenceKey, selected)
            }

            const mailboxPresent = mailboxExisted || admission?.verdict === "yes"
            const baseRef = { ...ref }
            delete baseRef.hint
            delete baseRef.pairGeneration
            const boundRef: MessageRef = mailboxPresent
                ? {
                    ...baseRef,
                    pairGeneration: selected.generation,
                    hint: { senderDID: key, declarationCID: selected.declarationCID },
                }
                : baseRef
            // A request entry keeps its sender's proof with it. Its CAR is
            // charged to the request quota in the same decision as the entry,
            // unless a live proof is already held or the sender has a pair
            // mailbox, whose proof is not budgeted.
            const proofBytes = mailboxPresent || selected.car.byteLength > 0 ? 0 : evidence.car.byteLength
            const result = admission === undefined
                ? (await this.hasMailbox(key))
                    ? await this.append(key, boundRef, nonce, nowSeconds)
                    : await this.appendRequest(key, boundRef, nonce, nowSeconds, proofBytes)
                : await this.receiveWith(key, boundRef, nonce, nowSeconds, admission, proofBytes)

            const accepted = ("persistBody" in result) && result.persistBody &&
                (result.outcome === "appended" || result.outcome === "queued")
            const held = result.outcome === "held"
            if (accepted) {
                const latest = await this.db.get<StoredPairEvidence>(evidenceKey)
                selected = generationChanged || latest?.car.byteLength === 0
                    ? {
                        ...selected,
                        ...evidence,
                        generation: selected.generation,
                        requestAccountedBytes: latest?.requestAccountedBytes ?? 0,
                    }
                    : {
                        ...(latest ?? selected),
                        expiresAt: Math.max(latest?.expiresAt ?? 0, evidence.expiresAt),
                    }
                await this.db.put(evidenceKey, selected)
                await this.schedulePairEvidenceExpiry(key, selected.expiresAt)
                const queue = await this.db.get<MessageRef[]>(mailboxKey(key))
                if (queue !== undefined) {
                    const updated = queue.map((entry) => entry.messageId === ref.messageId
                        ? {
                            ...entry,
                            pairGeneration: selected.generation,
                            hint: { senderDID: key, declarationCID: selected.declarationCID },
                        }
                        : entry)
                    await this.db.put(mailboxKey(key), updated)
                }
            } else if (held) {
                const current = await this.db.get<StoredPairEvidence>(evidenceKey)
                const hasHeldProof = current !== undefined && current.car.byteLength > 0
                selected = hasHeldProof
                    ? { ...current, expiresAt: Math.max(current.expiresAt, evidence.expiresAt) }
                    : { ...selected, ...evidence, generation: selected.generation, requestAccountedBytes: proofBytes }
                await this.db.put(evidenceKey, selected)
                const heldRefs = (await this.db.get<MessageRef[]>(requestKey(key))) ?? []
                await this.db.put(requestKey(key), heldRefs.map((entry) => ({
                    ...entry,
                    pairGeneration: selected.generation,
                    hint: { senderDID: key, declarationCID: selected.declarationCID },
                })))
                await this.schedulePairEvidenceExpiry(key, selected.expiresAt)
            } else if ((prior !== undefined || mailboxExisted) && selected.car.byteLength === 0) {
                await this.schedulePairEvidenceExpiry(key, selected.expiresAt)
            }

            return {
                result,
                generation: selected.generation,
                evidenceCID: selected.declarationCID,
                generationChanged,
                recycledMessageIds,
            }
        })
    }

    async getPairEvidence(
        key: `did:${string}`,
        evidenceCID: string,
        nowSeconds: number
    ): Promise<StoredPairMailboxEvidence | null> {
        const evidence = await this.db.get<StoredPairEvidence>(pairEvidenceKey(key))
        if (evidence === undefined || evidence.declarationCID !== evidenceCID ||
            evidence.car.byteLength === 0) return null
        const deep = (await this.db.get<MessageRef[]>(mailboxKey(key))) !== undefined
        if (!deep && (await this.db.get<MessageRef[]>(requestKey(key))) === undefined) return null
        if (evidence.expiresAt <= nowSeconds) {
            await this.expireProof(key, deep)
            return null
        }
        return evidence
    }

    /**
     * Appends to a pair mailbox, or advances the synthetic
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
                ? await this.advanceSynthetic(
                      key,
                      blocked,
                      nowSeconds,
                      // A pair key reaches `append` only without an admission
                      // source, where an unblocked sender with no pair mailbox
                      // meets the request depth.
                      isPairMailboxKey(key) ? this.requestDepth() : this.capacity()
                  )
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
     *
     * `capacity` is the depth this put would meet unblocked: the pair
     * mailbox's when admission would admit it, the request mailbox's
     * otherwise. A blocked sender then refuses where an unblocked one does,
     * so the point where a 429 starts does not say which it is.
     */
    private async advanceSynthetic(
        key: MailboxKey,
        stored: SyntheticState,
        nowSeconds: number,
        capacity: number
    ): Promise<AppendResult> {
        if (isPairMailboxKey(key)) {
            // The request path reads these before it decides; reading them
            // here keeps a blocked sender's put as much storage work as an
            // unblocked one's.
            await this.db.get(requestKey(key))
            await this.db.get(KEY_REQUEST_BYTES)
            await this.db.get(mailboxKey(key))
            await this.db.get(KEY_REQUEST_SWEEP_AT)
        }
        const retryInstant = await this.retryInstant(key, nowSeconds)
        const { state, accepted } = this.synthetic.advance(
            stored,
            nowSeconds,
            capacity,
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

    /**
     * Idempotent: the client's ack path retries (contract 6). A sender's
     * pair and request entries share its key, so both tiers are searched.
     */
    async remove(key: MailboxKey, messageId: MessageId, pairGeneration?: string): Promise<void> {
        const removable = (existing: MessageRef) =>
            !(isPairMailboxKey(key) && pairGeneration !== undefined && pairGeneration !== existing.pairGeneration)

        const queue = await this.db.get<MessageRef[]>(mailboxKey(key))
        const existing = queue?.find((r) => r.messageId === messageId)
        if (queue !== undefined && existing !== undefined && removable(existing)) {
            await this.db.put(mailboxKey(key), queue.filter((r) => r.messageId !== messageId))
        }

        const requests = await this.db.get<MessageRef[]>(requestKey(key))
        const request = requests?.find((r) => r.messageId === messageId)
        if (requests === undefined || request === undefined || !removable(request)) return
        await this.writeRequest(
            key,
            requests,
            requests.filter((r) => r.messageId !== messageId)
        )
    }

    /** Persists a request mailbox's new contents: gone when empty, with the bytes it no longer holds refunded. */
    private async writeRequest(key: MailboxKey, before: MessageRef[], after: MessageRef[]): Promise<void> {
        if (after.length === 0) await this.db.delete(requestKey(key))
        else await this.db.put(requestKey(key), after)
        const freed = before.reduce((n, r) => n + r.byteLength, 0) - after.reduce((n, r) => n + r.byteLength, 0)
        const used = (await this.db.get<number>(KEY_REQUEST_BYTES)) ?? 0
        await this.db.put(KEY_REQUEST_BYTES, Math.max(0, used - freed))
        if (after.length === 0) await this.releaseRequestProof(key)
    }

    /**
     * A sender's proof leaves the shared quota with its last request entry.
     * With no pair mailbox the proof has no other purpose and its row goes;
     * with one, the row stays as that mailbox's proof, charged to no quota,
     * and a blocked sender's row stays as its watermark.
     */
    private async releaseRequestProof(key: MailboxKey): Promise<void> {
        if (!isPairMailboxKey(key)) return
        const proof = await this.db.get<StoredPairEvidence>(pairEvidenceKey(key))
        if (proof === undefined) return
        const charged = proof.requestAccountedBytes ?? 0
        if (charged > 0) {
            const used = (await this.db.get<number>(KEY_REQUEST_BYTES)) ?? 0
            await this.db.put(KEY_REQUEST_BYTES, Math.max(0, used - charged))
        }
        // A blocked sender's row is its anti-rollback watermark: it stays.
        const kept = (await this.db.get(mailboxKey(key))) !== undefined ||
            (await this.db.get(syntheticKey(key))) !== undefined
        if (!kept) {
            await this.db.delete(pairEvidenceKey(key))
        } else if (charged > 0) {
            await this.db.put(pairEvidenceKey(key), { ...proof, requestAccountedBytes: 0 })
        }
    }

    /** Drops a sender's request mailbox and proof, returning their bytes to the shared quota. */
    private async releaseRequest(key: MailboxKey): Promise<void> {
        const requests = (await this.db.get<MessageRef[]>(requestKey(key))) ?? []
        await this.writeRequest(key, requests, [])
    }

    /**
     * Retention for a proof that has expired. A sender with no pair mailbox
     * has only request entries, whose bodies have expired with it: they go
     * too. One with a pair mailbox keeps its entries and only loses the CAR.
     */
    private async expireProof(key: PairMailboxKey, hasPairMailbox: boolean): Promise<void> {
        if (hasPairMailbox) await this.clearPairProof(key)
        else await this.releaseRequest(key)
    }

    async getMessage(key: MailboxKey, messageId: MessageId): Promise<MessageRef | null> {
        // `db.get` throws on an over-long key; a miss must look like any other.
        if (new TextEncoder().encode(mailboxKey(key)).length > MAX_KEY_BYTES) return null
        const queue = await this.db.get<MessageRef[]>(mailboxKey(key))
        const deep = queue?.find((r) => r.messageId === messageId)
        if (deep !== undefined) return deep
        const requests = await this.db.get<HeldRef[]>(requestKey(key))
        const held = requests?.find((r) => r.messageId === messageId)
        return held === undefined ? null : unheld(held)
    }

    async hasMailbox(key: MailboxKey): Promise<boolean> {
        if ((await this.db.get(mailboxKey(key))) !== undefined) return true
        return (await this.db.get(syntheticKey(key))) !== undefined
    }

    async receive(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        admission: Admission
    ): Promise<ReceiveResult> {
        return this.receiveWith(key, ref, nonce, nowSeconds, admission, 0)
    }

    /** `receive`, reserving `proofBytes` in the shared request quota when the put lands in a request mailbox. */
    private async receiveWith(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        admission: Admission,
        proofBytes: number
    ): Promise<ReceiveResult> {
        const seen = await this.loadNonces(key)
        if (seen.includes(nonceHex(nonce))) return { outcome: "duplicate" }

        let blocked = await this.db.get<SyntheticState>(syntheticKey(key))
        if (admission.verdict === "blocked" && blocked === undefined) {
            await this.block(key, nowSeconds, "bsky")
            blocked = await this.db.get<SyntheticState>(syntheticKey(key))
        }
        if (blocked !== undefined) {
            const result = await this.advanceSynthetic(
                key,
                blocked,
                nowSeconds,
                admission.verdict === "yes" ? this.capacity() : this.requestDepth()
            )
            if (result.outcome === "appended") await this.recordNonce(key, nonce, seen)
            return toReceiveResult(result)
        }

        if (admission.verdict === "yes") {
            const queue = await this.db.get<MessageRef[]>(mailboxKey(key))
            return this.admit(key, ref, nonce, nowSeconds, queue ?? [], seen)
        }
        // A blocked verdict always ends on the synthetic path above.
        if (admission.verdict === "blocked") throw new Error("unreachable")
        return this.appendRequest(key, ref, nonce, nowSeconds, proofBytes, seen)
    }

    /**
     * Queue a put the recipient's policy admitted, opening the sender's pair
     * mailbox if need be. Refused, writing nothing, only when the new ref
     * itself does not fit; the oldest request entries that fit ahead of it
     * move in, with their ids and fields, and the rest stay held.
     */
    private async admit(
        key: MailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        queue: MessageRef[],
        seen: string[]
    ): Promise<ReceiveResult> {
        const requests = (await this.db.get<HeldRef[]>(requestKey(key))) ?? []
        // A message id names one entry in exactly one tier.
        if (requests.some((r) => r.messageId === ref.messageId)) return { outcome: "duplicate" }
        const capacity = this.capacity()
        if (queue.length >= capacity) {
            return {
                outcome: "refused",
                retryAfter: await this.retryInstant(key, nowSeconds),
            }
        }
        const moved = requests.slice(0, capacity - queue.length - 1).map(unheld)
        await this.db.put(mailboxKey(key), [...queue, ...moved, ref])
        if (moved.length > 0) await this.writeRequest(key, requests, requests.slice(moved.length))
        await this.recordNonce(key, nonce, seen)
        return { outcome: "queued", persistBody: true, ...(moved.length > 0 ? { moved } : {}) }
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
        // Older clients may return the prior physical `mbox:` cursor; newer
        // pages use the shared logical mailbox key to merge message rows and
        // empty pair-generation descriptors in one stable order.
        const encoded = cursor?.startsWith("@") === true
        const physical =
            cursor?.startsWith(MAILBOX_PREFIX) === true ||
            cursor?.startsWith(PAIR_EVIDENCE_PREFIX) === true
        const after = encoded
            ? cursor!.slice(1)
            : cursor?.startsWith(MAILBOX_PREFIX)
              ? cursor.slice(MAILBOX_PREFIX.length)
              : cursor?.startsWith(PAIR_EVIDENCE_PREFIX)
                ? cursor.slice(PAIR_EVIDENCE_PREFIX.length)
                : cursor
        const startAfterMailbox =
            after === null
                ? undefined
                : encoded || physical
                  ? mailboxKey(after as MailboxKey)
                  : cursor!
        const startAfterEvidence =
            after === null
                ? undefined
                : encoded || physical
                  ? pairEvidenceKey(after as MailboxKey)
                  : cursor!
        const [mailboxes, proofs] = await Promise.all([
            this.db.list<MessageRef[]>({
                prefix: MAILBOX_PREFIX,
                startAfter: startAfterMailbox,
                limit: limit + 1,
            }),
            this.db.list<StoredPairEvidence>({
                prefix: PAIR_EVIDENCE_PREFIX,
                startAfter: startAfterEvidence,
                limit: limit + 1,
            }),
        ])
        const combined = new Map<MailboxKey, MailboxSnapshot>()
        for (const [rawKey, messages] of mailboxes) {
            const key = rawKey.slice(MAILBOX_PREFIX.length) as MailboxKey
            combined.set(key, { key, messages })
        }
        for (const [rawKey, evidence] of proofs) {
            const key = rawKey.slice(PAIR_EVIDENCE_PREFIX.length) as MailboxKey
            const previous = combined.get(key)
            if (evidence.expiresAt > 0 && evidence.expiresAt <= Math.floor(Date.now() / 1000)) {
                await this.expireProof(
                    key as PairMailboxKey,
                    (await this.db.get<MessageRef[]>(mailboxKey(key))) !== undefined
                )
            }
            // Request-only senders have no mailbox descriptor. Proof metadata
            // alone must never reveal a sender to the owner.
            if (previous === undefined) continue
            combined.set(key, {
                key,
                messages: previous?.messages ?? [],
                pairGeneration: evidence.generation,
            })
        }
        const all = [...combined.values()].sort((a, b) =>
            a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        )
        const rows = all.slice(0, limit)
        const hasMore = all.length > limit || mailboxes.size > limit || proofs.size > limit
        const entries = rows.filter((entry) => entry.messages.length > 0 || entry.pairGeneration !== undefined)
        return {
            entries,
            nextCursor: hasMore && rows.length > 0 ? `@${rows[rows.length - 1]!.key}` : null,
        }
    }

    // MARK: - Request mailboxes

    async appendToRequest(
        key: PairMailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number
    ): Promise<RequestAppendResult> {
        return this.appendRequest(key, ref, nonce, nowSeconds, 0)
    }

    /**
     * Depth is judged before the shared quota, so a full sender refuses
     * whatever the quota's state. Every read happens before any decision,
     * so a dropped put issues the same reads as a held one and skips only
     * the writes. There is no I/O outside this object's storage between the
     * reads and the writes, which keeps the whole put atomic.
     *
     * `extraBytes` is what the caller will newly account alongside the entry
     * (a proof it holds for this sender), reserved in the same decision so
     * the entry and its proof are kept together or not at all.
     */
    private async appendRequest(
        key: MailboxKey,
        ref: MessageRef,
        nonce: Nonce,
        nowSeconds: number,
        extraBytes: number,
        preloadedNonces?: string[]
    ): Promise<RequestAppendResult> {
        const seen = preloadedNonces ?? (await this.loadNonces(key))
        if (seen.includes(nonceHex(nonce))) return { outcome: "duplicate" }

        const queue = (await this.db.get<HeldRef[]>(requestKey(key))) ?? []
        const used = (await this.db.get<number>(KEY_REQUEST_BYTES)) ?? 0
        const deep = (await this.db.get<MessageRef[]>(mailboxKey(key))) ?? []
        const sweepAt = await this.db.get<number>(KEY_REQUEST_SWEEP_AT)
        // A message id names one entry in exactly one tier.
        if (deep.some((r) => r.messageId === ref.messageId)) return { outcome: "duplicate" }

        if (queue.length >= this.requestDepth()) {
            return {
                outcome: "refused",
                retryAfter: await this.retryInstant(key, nowSeconds),
            }
        }
        const total = ref.byteLength + extraBytes
        if (used + total > this.requestCapBytes()) {
            return { outcome: "dropped" }
        }

        queue.push({ ...ref, heldAt: Math.floor(Date.now() / 1000) })
        await this.db.put(requestKey(key), queue)
        await this.db.put(KEY_REQUEST_BYTES, used + total)
        await this.recordNonce(key, nonce, seen)
        await this.armRequestSweep(sweepAt)
        return { outcome: "held" }
    }

    /**
     * The ids among `refs` whose bodies are no longer stored: the retention
     * that governs a body is the entry's too. An entry too young for its body
     * to be written, and propagated to wherever this reads, is not judged; nor
     * is one whose body store cannot be read. This awaits the body store, so
     * a caller must not hold a read of `req:` across it: judge first, then
     * `dropExpired` against fresh storage.
     */
    private async deadEntries(refs: HeldRef[]): Promise<Set<MessageId>> {
        const old = refs.filter((r) => (r.heldAt ?? 0) <= requestJudgementCutoff())
        const dead = new Set<MessageId>()
        await Promise.all(
            old.map(async (r) => {
                if (!(await this.bodyStored(r.messageId))) dead.add(r.messageId)
            })
        )
        return dead
    }

    /**
     * Whether the body for `id` is still stored; a request entry whose body
     * is gone has expired. This reads `env.messages`, the namespace
     * `kvBodyStore` writes bodies to. A deployment that writes them anywhere
     * else MUST override this to read that store, or every request entry is
     * dropped once it is older than the grace window. A read that fails
     * reports the body as stored.
     */
    protected async bodyStored(id: MessageId): Promise<boolean> {
        try {
            const body = await this.env.messages.get(id, "stream")
            if (body === null) return false
            await body.cancel()
            return true
        } catch {
            // Unreadable, including past the platform's per-request read limit.
            return true
        }
    }

    /**
     * Removes the entries of `key` that `deadEntries` found dead, re-reading
     * storage so nothing that changed while the body store was consulted is
     * overwritten, and returns their bytes, and the proof's with the last, to
     * the quota. Storage operations only: atomic.
     */
    private async dropExpired(key: MailboxKey, dead: ReadonlySet<MessageId>): Promise<void> {
        if (dead.size === 0) return
        const refs = await this.db.get<HeldRef[]>(requestKey(key))
        if (refs === undefined) return
        const cutoff = requestJudgementCutoff()
        const alive = refs.filter((r) => !(dead.has(r.messageId) && (r.heldAt ?? 0) <= cutoff))
        if (alive.length !== refs.length) await this.writeRequest(key, refs, alive)
    }

    /** Arms the sweep for a day out when none is due, and re-arms one whose alarm was lost. */
    private async armRequestSweep(dueAt: number | undefined): Promise<void> {
        const nowMs = Date.now()
        if (dueAt === undefined) {
            const next = Math.floor(nowMs / 1000) + REQUEST_SWEEP_INTERVAL_SECONDS
            await this.db.put(KEY_REQUEST_SWEEP_AT, next)
            const current = await this.db.getAlarm()
            if (current === null || next * 1000 < current) await this.db.setAlarm(next * 1000)
        } else if (dueAt * 1000 <= nowMs && (await this.db.getAlarm()) === null) {
            await this.db.setAlarm(nowMs + 1_000)
        }
    }

    async requestMailboxes(
        cursor: string | null,
        limit: number
    ): Promise<RequestMailboxesPage> {
        const rows = await this.db.list<HeldRef[]>({
            prefix: REQUEST_PREFIX,
            startAfter: cursor === null || cursor === "" ? undefined : cursor,
            limit: limit + 1,
        })
        const all = [...rows]
        const page = all.slice(0, limit)
        // Judge every entry before changing any: the body store is awaited,
        // and no read of this object's own storage may span it.
        const judged = await Promise.all(page.map(async ([, refs]) => this.deadEntries(refs)))
        const entries: RequestMailbox[] = []
        for (const [i, [raw, refs]] of page.entries()) {
            const key = raw.slice(REQUEST_PREFIX.length) as PairMailboxKey
            const dead = judged[i]!
            await this.dropExpired(key, dead)
            const alive = refs.filter((r) => !dead.has(r.messageId))
            if (alive.length > 0) entries.push({ key, messageIds: alive.map((r) => r.messageId) })
        }
        return {
            entries,
            nextCursor: all.length > limit && page.length > 0 ? page[page.length - 1]![0] : null,
        }
    }

    // MARK: - Blocking

    async block(
        key: MailboxKey,
        _nowSeconds: number,
        source: BlockSource = "device"
    ): Promise<void> {
        // A device block takes over a mirrored one, so it leaves
        // `bs`; the marker is dropped before the early return.
        if (source === "device") await this.db.delete(bskyBlockKey(key))
        if (isPairMailboxKey(key)) await this.clearPairProof(key)
        if ((await this.db.get(syntheticKey(key))) !== undefined) {
            // An entry can land between a put's mailbox check and its hold.
            await this.releaseRequest(key)
            return
        }

        // An empty state is the blocked marker. Deliberately NOT seeded by
        // calling `advance` — that would count a fill at block time, so the
        // sender's first subsequent put would land one slot further along
        // than a real mailbox's, which is a distinguisher. `advance`
        // receives this empty object on the first put and initializes.
        await this.db.put(syntheticKey(key), {} satisfies SyntheticState)
        if (source === "bsky") await this.db.put(bskyBlockKey(key), true)

        // Dropping the queue is the point, not a side effect: no bytes are
        // kept for a blocked sender.
        await this.db.delete(mailboxKey(key))

        // And the request mailbox, for the same reason: a blocked sender
        // would otherwise still surface in the owner's request listing. The
        // quota gets its bytes back.
        await this.releaseRequest(key)
    }

    private async clearPairProof(key: PairMailboxKey): Promise<void> {
        const proof = await this.db.get<StoredPairEvidence>(pairEvidenceKey(key))
        if (proof !== undefined) {
            const used = (await this.db.get<number>(KEY_REQUEST_BYTES)) ?? 0
            await this.db.put(KEY_REQUEST_BYTES, Math.max(0, used - (proof.requestAccountedBytes ?? 0)))
            await this.db.put(pairEvidenceKey(key), {
                ...proof,
                car: new Uint8Array(),
                expiresAt: 0,
                requestAccountedBytes: 0,
            })
        }
    }

    private async schedulePairEvidenceExpiry(key: PairMailboxKey, expiresAt: number): Promise<void> {
        // Zero marks a retained anti-rollback watermark after the proof bytes
        // were cleared. It has no expiry to schedule or fold into a paged scan.
        if (expiresAt === 0) return
        const next = expiresAt * 1000
        const current = await this.db.getAlarm()
        if (current === null || next < current) await this.db.setAlarm(next)
        const cursor = await this.db.get<string>(KEY_PAIR_EVIDENCE_EXPIRY_CURSOR)
        if (cursor !== undefined && pairEvidenceKey(key) <= cursor) {
            // This row sorts before the current page; retain its deadline in
            // the in-progress minimum without restarting the bounded scan.
            const passMin = await this.db.get<number>(KEY_PAIR_EVIDENCE_EXPIRY_MIN)
            await this.db.put(KEY_PAIR_EVIDENCE_EXPIRY_MIN, Math.min(passMin ?? Number.POSITIVE_INFINITY, expiresAt))
        }
    }

    /**
     * Reclaims selected declaration CARs at their message-retention deadline,
     * and, when its time comes, sweeps request entries whose bodies expired.
     */
    async alarm(): Promise<void> {
        const nowSeconds = Math.floor(Date.now() / 1000)
        // The body store is consulted before the object is held.
        const requestPass = await this.judgeRequestSweep(nowSeconds)
        await this.ctx.blockConcurrencyWhile(async () => {
            const proofAlarmMs = await this.sweepExpiredProofs(nowSeconds)
            const sweepAlarmMs = await this.applyRequestSweep(requestPass, nowSeconds)
            const next = Math.min(proofAlarmMs ?? Number.POSITIVE_INFINITY, sweepAlarmMs ?? Number.POSITIVE_INFINITY)
            if (Number.isFinite(next)) await this.db.setAlarm(next)
        })
    }

    /** One bounded pass over the proof rows; the alarm time it wants next, if any. */
    private async sweepExpiredProofs(nowSeconds: number): Promise<number | null> {
        const cursor = await this.db.get<string>(KEY_PAIR_EVIDENCE_EXPIRY_CURSOR)
        const proofs = await this.db.list<StoredPairEvidence>({
            prefix: PAIR_EVIDENCE_PREFIX,
            ...(cursor !== undefined ? { startAfter: cursor } : {}),
            limit: PAIR_EVIDENCE_EXPIRY_BATCH_SIZE,
        })
        let nextExpiry = Number.POSITIVE_INFINITY
        for (const [rawKey, proof] of proofs) {
            const key = rawKey.slice(PAIR_EVIDENCE_PREFIX.length) as PairMailboxKey
            if (proof.expiresAt === 0) continue
            if (proof.expiresAt <= nowSeconds) {
                await this.expireProof(key, (await this.db.get<MessageRef[]>(mailboxKey(key))) !== undefined)
            } else {
                nextExpiry = Math.min(nextExpiry, proof.expiresAt)
            }
        }
        const previousMin = await this.db.get<number>(KEY_PAIR_EVIDENCE_EXPIRY_MIN)
        const passMin = Math.min(previousMin ?? Number.POSITIVE_INFINITY, nextExpiry)
        if (proofs.size === PAIR_EVIDENCE_EXPIRY_BATCH_SIZE) {
            const lastKey = [...proofs.keys()].at(-1)
            if (lastKey !== undefined) await this.db.put(KEY_PAIR_EVIDENCE_EXPIRY_CURSOR, lastKey)
            if (Number.isFinite(passMin)) await this.db.put(KEY_PAIR_EVIDENCE_EXPIRY_MIN, passMin)
            else await this.db.delete(KEY_PAIR_EVIDENCE_EXPIRY_MIN)
            return Math.min(passMin * 1000, Date.now() + 1_000)
        }
        await this.db.delete(KEY_PAIR_EVIDENCE_EXPIRY_CURSOR)
        await this.db.delete(KEY_PAIR_EVIDENCE_EXPIRY_MIN)
        return Number.isFinite(passMin) ? passMin * 1000 : null
    }

    /** When the next request sweep is due, and if it is due now, the senders it covers and their dead entries. */
    private async judgeRequestSweep(nowSeconds: number): Promise<RequestSweepPass> {
        const dueAt = await this.db.get<number>(KEY_REQUEST_SWEEP_AT)
        if (dueAt === undefined || dueAt > nowSeconds) return { dueAt }

        const cursor = await this.db.get<string>(KEY_REQUEST_SWEEP_CURSOR)
        const rows = await this.db.list<HeldRef[]>({
            prefix: REQUEST_PREFIX,
            ...(cursor !== undefined ? { startAfter: cursor } : {}),
            limit: REQUEST_SWEEP_BATCH_SIZE,
        })
        const senders = [...rows]
        const dead = await Promise.all(senders.map(async ([, refs]) => this.deadEntries(refs)))
        return {
            dueAt,
            senders: senders.map(([raw], i) => ({
                key: raw.slice(REQUEST_PREFIX.length) as MailboxKey,
                dead: dead[i]!,
            })),
            full: rows.size === REQUEST_SWEEP_BATCH_SIZE,
        }
    }

    /**
     * Applies a request sweep pass; the alarm time it wants next, if any.
     * Not due, it only reports when it will be; with no request entry left
     * it disarms.
     */
    private async applyRequestSweep(pass: RequestSweepPass, nowSeconds: number): Promise<number | null> {
        if (pass.dueAt === undefined) return null
        if (pass.senders === undefined) return pass.dueAt * 1000

        for (const { key, dead } of pass.senders) await this.dropExpired(key, dead)
        if (pass.full) {
            await this.db.put(KEY_REQUEST_SWEEP_CURSOR, requestKey(pass.senders.at(-1)!.key))
            return Date.now() + 1_000
        }
        await this.db.delete(KEY_REQUEST_SWEEP_CURSOR)
        if ((await this.db.list({ prefix: REQUEST_PREFIX, limit: 1 })).size === 0) {
            await this.db.delete(KEY_REQUEST_SWEEP_AT)
            return null
        }
        const next = nowSeconds + REQUEST_SWEEP_INTERVAL_SECONDS
        await this.db.put(KEY_REQUEST_SWEEP_AT, next)
        return next * 1000
    }

    async unblock(key: MailboxKey): Promise<void> {
        await this.db.delete(syntheticKey(key))
        await this.db.delete(bskyBlockKey(key))
    }

    async syncBskyBlocks(blocked: ReadonlySet<string>): Promise<void> {
        const held = new Set<string>()
        for (const [prefix, family] of [
            [REQUEST_PREFIX, "req"],
            [MAILBOX_PREFIX, "mbox"],
        ] as const) {
            const keys = await this.db.list({ prefix })
            for (const k of keys.keys()) {
                const sender = k.slice(prefix.length)
                // Grant mailboxes name no sender.
                if (family === "mbox" && !isPairMailboxKey(sender)) continue
                held.add(sender)
            }
        }
        for (const sender of held) {
            const key = sender as PairMailboxKey
            if (blocked.has(sender)) await this.block(key, 0, "bsky")
        }
    }

    async listBskyBlocked(): Promise<string[]> {
        const entries = await this.db.list({ prefix: BSKY_BLOCK_PREFIX })
        return [...entries.keys()].map((k) => k.slice(BSKY_BLOCK_PREFIX.length))
    }

    /** The block markers' own keys — the DIDs. No second table to drift. */
    async listBlocked(): Promise<string[]> {
        const entries = await this.db.list<SyntheticState>({
            prefix: SYNTHETIC_PREFIX,
        })
        return [...entries.keys()].map((k) => k.slice(SYNTHETIC_PREFIX.length))
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
        await this.db.put(grantRowKey(address), {
            address,
            expiresAt,
            closed: false,
        } satisfies GrantRow)
    }

    async listGrants(): Promise<GrantSummary[]> {
        const entries = await this.db.list<GrantRow>({ prefix: GRANT_ROW_PREFIX })
        return [...entries.values()]
    }

    async getGrant(address: string): Promise<GrantSummary | null> {
        return (await this.db.get<GrantRow>(grantRowKey(address))) ?? null
    }

    /** A no-op if `address` was never issued by this owner. */
    async setGrantClosed(address: string, closed: boolean): Promise<void> {
        const row = await this.db.get<GrantRow>(grantRowKey(address))
        if (row === undefined) return
        await this.db.put(grantRowKey(address), { ...row, closed })
    }

    async invalidateGrant(address: string): Promise<void> {
        await this.db.delete(grantRowKey(address))
        // May have been the last live grant of a drain, which ends it for
        // this registration — the one capability transition this object
        // can cause rather than merely observe.
        await this.broadcastCapabilities()
    }

    // MARK: - Teardown

    /**
     * Tear down all of this registration's stored state. Reached by locator,
     * not by DID: the caller has already removed the routing row.
     */
    async destroy(): Promise<void> {
        await this.db.deleteAll()
    }
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
}

function summaryPartKeys(token: string, from: number, to: number): string[] {
    return Array.from({ length: Math.max(0, to - from) }, (_, i) => summaryPartKey(token, from + i))
}

function splitSummaryIndex(index: SummaryIndex): SummaryPart[] {
    const parts: SummaryPart[] = []
    for (const [field, items] of [
        ["ownBlocks", index.ownBlocks],
        ["records", index.records],
        ["verdicts", index.verdicts],
    ] as const) {
        let current: unknown[] = []
        let chars = 0
        for (const item of items) {
            const size = JSON.stringify(item).length
            if (current.length > 0 && chars + size > SUMMARY_PART_CHARS) {
                parts.push({ field, items: current })
                current = []
                chars = 0
            }
            current.push(item)
            chars += size
        }
        if (current.length > 0) parts.push({ field, items: current })
    }
    return parts
}

function toReceiveResult(result: AppendResult): ReceiveResult {
    return result.outcome === "appended"
        ? { outcome: "queued", persistBody: result.persistBody }
        : result
}
