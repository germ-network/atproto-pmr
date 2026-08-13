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

/** Which of the three functions this deployment serves. */
export type ServedFunction = "mailboxes" | "observation"

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
