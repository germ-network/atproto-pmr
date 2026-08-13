/**
 * Deployment parameters and the capability document generated from them.
 *
 * Every value here is **implementation-defined** — the specification fixes
 * none of them (`spec/wire-api.md`, "Limits are implementation-defined").
 * There are no defaults in this package on purpose: a default becomes a de
 * facto standard, and these are exactly the values the specification says
 * an operator should choose. Pass your own.
 */

export interface PMRLimits {
    /** Maximum sealed-payload size for a pair put, bytes. */
    messageMaxBytes: number
    /** Headroom over `messageMaxBytes` for the COSE envelope around it. */
    framingAllowanceBytes: number
    /** Message retention, seconds. */
    messageExpirySeconds: number
    /** Per-sender capacity of a provisioned pair mailbox. */
    maxMessagesPerPairSender: number
    /** Challenge TTL, seconds. */
    challengeExpirySeconds: number
    /** How long an issued grant lives before it must be reissued, seconds. */
    grantExpirySeconds: number
    /** Refuses a single `POST /pmr/v1/grants` request for more than this many. */
    maxGrantsPerRequest: number
}

export interface PoolLimits {
    /**
     * The pool is bounded by BYTES, never by sender count: width is the
     * property it exists to provide, and a sender-count cap rations exactly
     * the thing the design says not to pre-judge.
     */
    capBytes: number
    depthPerSender: number
    /** Under pressure, depth gives and width holds. */
    depthUnderPressure: number
    /** How long a discarded sender is suppressed before lapsing, seconds. */
    discardWindowSeconds: number
}

/**
 * Grants are the one thing a relay vends to third parties, so they are the
 * one thing whose retirement a peer can observe: peers hold addresses they
 * will keep putting to. `draining` stops vending and keeps serving until
 * the last outstanding grant expires.
 *
 * Operating mailboxes is not itself a declared capability — a relay serves
 * both kinds or is not a relay (`spec/wire-api.md`). This is a *state*, not
 * a switch.
 */
export type GrantLifecycle = "active" | "draining" | "absent"

const GRANT_LIFECYCLES: readonly GrantLifecycle[] = [
    "active",
    "draining",
    "absent",
]

export function parseGrantLifecycle(raw: string): GrantLifecycle {
    if (!GRANT_LIFECYCLES.includes(raw as GrantLifecycle)) {
        throw new Error(
            `Unknown grant lifecycle "${raw}"; ` +
                `expected one of ${GRANT_LIFECYCLES.join(", ")}`
        )
    }
    return raw as GrantLifecycle
}

/**
 * Which capability families a deployment serves.
 *
 * Short tokens rather than JMAP's vendor URLs. JMAP needs globally unique
 * URIs because capabilities from many vendors land in one namespace; this
 * document is already scoped by its own well-known path, so there is no
 * shared registry to collide in. Unprefixed tokens are reserved to the
 * specification; an extension uses a URL on a domain it owns
 * (`spec/wire-api.md`, "The enabler document").
 *
 * `core` is always served — registrations, challenges, the events socket —
 * and exists as an entry so that surface has somewhere to declare its own
 * prefix and versions. Without it, `POST /pmr/v1/challenges` would be the
 * one path a client could not discover.
 */
export type CapabilityName = "core" | "didMailbox" | "grant" | "watch"

/** What every capability entry carries, whatever else it adds. */
export interface CapabilityBase {
    /**
     * API versions this deployment speaks for this capability, newest last.
     * A departure from JMAP, where the capability URI *is* the version and a
     * breaking change means a new URI. Explicit here because the version
     * already appears in the path, so a second encoding of it would be a
     * second thing to keep in step.
     */
    versions: readonly string[]
    /**
     * Where this capability's endpoints live, without a trailing slash —
     * the paths in `spec/wire-api.md` are relative to it.
     *
     * Also a departure: JMAP routes every capability through one shared
     * `apiUrl`, which suits a single-endpoint RPC protocol and not a REST
     * one. Two capabilities MAY name the same prefix, and `didMailbox` and
     * `grant` do — they share the inbox path and differ only in the key
     * they accept.
     */
    pathPrefix: string
}

export interface CoreCapability extends CapabilityBase {
    challengeExpiry: number
}

/** Common to both mailbox kinds, published per kind rather than once. */
export interface MailboxCapability extends CapabilityBase {
    messageMaxBytes: number
    messageExpiry: number
}

export interface GrantCapability extends MailboxCapability {
    lifecycle: GrantLifecycle
    maxPerRequest: number
}

/**
 * A capability a deployment does not serve is **absent**, never present
 * with a false-ish value: a client tests for the key.
 */
export interface Capabilities {
    core: CoreCapability
    didMailbox?: MailboxCapability
    grant?: GrantCapability
    watch?: CapabilityBase
}

/** Which capabilities a deployment serves, and where it serves them. */
export interface ServedCapabilities {
    pathPrefix: string
    versions: readonly string[]
    didMailbox: boolean
    grant: boolean
    watch?: { pathPrefix: string; versions: readonly string[] }
}

export interface PMRConfig {
    /**
     * The host this relay serves. A protocol input, not routing: grant
     * address derivation is domain-separated by it.
     */
    hostName: string
    limits: PMRLimits
    pool: PoolLimits
    /** What this deployment serves, and under which prefix. */
    serves: ServedCapabilities
    /**
     * Deployment-wide policy. The state a given client observes may differ:
     * a drain ends per-registration, when *that* registration's last grant
     * expires, so two clients of a draining deployment can legitimately see
     * `draining` and `absent` at the same moment.
     */
    grantLifecycle: GrantLifecycle
    /**
     * Human-readable prefix of the document's `state`, date-stamped rather
     * than counted by convention. Bumping it is optional — `state` also
     * carries a hash of the document's content, so a config-only change
     * moves it either way. This is for an operator reading a served
     * document and wanting to know which release it came from.
     */
    configState: string
}

export const SUPPORTED_API_VERSIONS = ["1"] as const

/**
 * Bodies are deterministic CBOR; the enabler document is the one JSON
 * resource (`spec/wire-api.md`, "Content types").
 */
export const SUPPORTED_ENCODINGS = ["application/cbor"] as const

/**
 * `GET /.well-known/private-messaging-enabler.json` — what a host serving
 * private messaging says it can do, and where.
 *
 * Modelled on JMAP's Session resource (RFC 8620 §2): capabilities are an
 * object keyed by name, each value carrying that capability's own
 * configuration, so a new capability adds a key rather than a parallel
 * array someone has to keep aligned.
 */
export interface EnablerDocument {
    state: string
    encodings: readonly string[]
    capabilities: Capabilities
}

/**
 * A cache token over the document's own content, not a digest: a collision
 * costs one client one missed refresh, so 32 bits is enough and the cost of
 * being wrong is bounded.
 *
 * Content-derived because most of what this document publishes comes from
 * deployment configuration — a lifecycle, a size cap — which an operator
 * changes without touching source. A hand-bumped constant would leave
 * `state` unchanged across exactly those deploys, and a client polling it
 * would miss the transition it polls for.
 */
function contentState(stamp: string, body: Omit<EnablerDocument, "state">): string {
    let hash = 0x811c9dc5
    for (const ch of JSON.stringify(body)) {
        hash ^= ch.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return `${stamp}.${hash.toString(16).padStart(8, "0")}`
}

/**
 * Generated from the enforcing config rather than written alongside it, so
 * a published value and the one actually enforced cannot drift.
 *
 * Deliberately publishes nothing about pool sizing or the blocked-sender
 * behavior: the first is implementation-defined and the second is
 * unpublished on purpose, since a published simulation is a fingerprint.
 */
export function buildEnablerDocument(config: PMRConfig): EnablerDocument {
    const { serves, limits } = config
    const mailbox = {
        versions: serves.versions,
        pathPrefix: serves.pathPrefix,
        messageMaxBytes: limits.messageMaxBytes,
        messageExpiry: limits.messageExpirySeconds,
    }
    const capabilities: Capabilities = {
        core: {
            versions: serves.versions,
            pathPrefix: serves.pathPrefix,
            challengeExpiry: limits.challengeExpirySeconds,
        },
    }
    if (serves.didMailbox) capabilities.didMailbox = mailbox
    if (serves.grant) {
        capabilities.grant = {
            ...mailbox,
            lifecycle: config.grantLifecycle,
            maxPerRequest: limits.maxGrantsPerRequest,
        }
    }
    if (serves.watch !== undefined) {
        capabilities.watch = {
            versions: serves.watch.versions,
            pathPrefix: serves.watch.pathPrefix,
        }
    }
    const body = { encodings: SUPPORTED_ENCODINGS, capabilities }
    return { state: contentState(config.configState, body), ...body }
}

/**
 * Public and cacheable. The document carries routing now, so a deployment
 * that moves a prefix must expect clients to hold the old one for up to
 * this long — the same discipline a DNS TTL asks for.
 *
 * JMAP RECOMMENDs no-store for its Session resource, but that document is
 * per-user and authenticated; this one is public and identical for every
 * caller, and `state` gives a client a cheap way to notice a change.
 */
export function serveEnablerDocument(config: PMRConfig): Response {
    return new Response(JSON.stringify(buildEnablerDocument(config)), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
        },
    })
}
