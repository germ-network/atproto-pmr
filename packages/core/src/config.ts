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
 * The four capabilities a deployment may serve — `spec/wire-api.md`,
 * "Capabilities, cardinality, and lifecycle". A deployment MUST NOT serve
 * the endpoints of one it does not declare here.
 */
export type ServedFunction =
    | "pairMailbox"
    | "grant"
    | "watch"
    | "observation"

/**
 * `grant` is the only capability that drains, because it is the only one
 * that has vended live commitments to third parties: peers hold addresses
 * they will keep putting to. `draining` stops vending and keeps serving
 * until the last outstanding grant expires.
 */
export type GrantLifecycle = "active" | "draining" | "absent"

export interface PMRConfig {
    /**
     * The host this relay serves. A protocol input, not routing: grant
     * address derivation is domain-separated by it.
     */
    hostName: string
    limits: PMRLimits
    pool: PoolLimits
    functions: readonly ServedFunction[]
    /**
     * Deployment-wide policy. The state a given client observes may differ:
     * a drain ends per-registration, when *that* registration's last grant
     * expires, so two clients of a draining deployment can legitimately see
     * `draining` and `absent` at the same moment.
     */
    grantLifecycle: GrantLifecycle
    /**
     * Bumped whenever a published limit changes, so a client can cache on
     * it. Date-stamped rather than counted, by convention.
     */
    configState: string
}

export const SUPPORTED_API_VERSIONS = ["1"] as const

/**
 * Bodies are deterministic CBOR; the capability document is the one JSON
 * resource (`spec/wire-api.md`, "Content types").
 */
export const SUPPORTED_ENCODINGS = ["application/cbor"] as const

export interface CapabilityDocument {
    state: string
    versions: readonly string[]
    encodings: readonly string[]
    functions: readonly string[]
    /** Omitted entirely when `grant` is not among `functions`. */
    grantLifecycle?: GrantLifecycle
    limits: Record<string, number>
}

/**
 * Generated from the enforcing config rather than written alongside it, so
 * a published limit and the value actually enforced cannot drift.
 *
 * Deliberately publishes nothing about pool sizing or the blocked-sender
 * behavior: the first is implementation-defined and the second is
 * unpublished on purpose, since a published simulation is a fingerprint.
 */
export function buildCapabilityDocument(config: PMRConfig): CapabilityDocument {
    return {
        state: config.configState,
        versions: SUPPORTED_API_VERSIONS,
        encodings: SUPPORTED_ENCODINGS,
        functions: config.functions,
        // Meaningless without the capability it describes, so it is absent
        // rather than reported as "absent" — a client reading a document
        // with no `grant` in `functions` has already been told.
        ...(config.functions.includes("grant")
            ? { grantLifecycle: config.grantLifecycle }
            : {}),
        limits: {
            messageMaxBytes: config.limits.messageMaxBytes,
            messageExpiry: config.limits.messageExpirySeconds,
            challengeExpiry: config.limits.challengeExpirySeconds,
        },
    }
}

/** Public and cacheable. */
export function serveCapabilityDocument(config: PMRConfig): Response {
    return new Response(JSON.stringify(buildCapabilityDocument(config)), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
        },
    })
}
