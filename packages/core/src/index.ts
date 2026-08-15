/**
 * `@germ-network/atproto-pmr-core` — protocol logic for an Atproto
 * Personal Messaging Relay, parameterized over a storage seam.
 *
 * This package makes no platform assumptions: no `fetch` global, no Workers
 * bindings, no `ExecutionContext`. Everything a handler needs is injected.
 * `@germ-network/atproto-pmr-cloudflare` supplies a Durable-Object-backed
 * storage implementation; a relational one is an equally first-class
 * consumer.
 *
 * The specification is in `spec/`. Where this code and the specification
 * disagree, the specification is right and this is a bug.
 */

// The storage seam.
export type {
    AppendResult,
    BodyStore,
    ChallengeStore,
    Directory,
    GrantMailboxKey,
    GrantSummary,
    Locator,
    MailboxKey,
    MailboxSnapshot,
    MessageId,
    MessageRef,
    Nonce,
    OpenMailboxesPage,
    PairMailboxKey,
    PMRStore,
    PoolAppendResult,
    PoolSender,
    RegistrationFields,
    ResolvedAddress,
    VerificationHint,
} from "./storage"

// The one inbox path's key prefixes.
export {
    asMailboxKey,
    asPairMailboxKey,
    grantMailboxKey,
    isPairMailboxKey,
    parseMailboxKey,
    type ParsedMailboxKey,
} from "./mailbox-key"

// The blocked-sender seam. Supply your own; do not publish it.
export {
    DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR,
    type SyntheticAdvance,
    type SyntheticBehavior,
    type SyntheticState,
} from "./synthetic"

// Deployment parameters and the enabler document generated from them.
export {
    buildEnablerDocument,
    parseGrantLifecycle,
    serveEnablerDocument,
    SUPPORTED_API_VERSIONS,
    SUPPORTED_ENCODINGS,
    type Capabilities,
    type CapabilityBase,
    type CapabilityName,
    type CoreCapability,
    type EnablerDocument,
    type GrantCapability,
    type GrantLifecycle,
    type MailboxCapability,
    type PMRConfig,
    type PMRLimits,
    type PoolLimits,
    type ServedCapabilities,
} from "./config"

// RFC 9421 HTTP Message Signatures.
export {
    buildSignatureBase,
    contentDigestMatches,
    verifyRequestSignature,
    BODY_COMPONENT,
    DEFAULT_LABEL,
    REQUIRED_COMPONENTS,
    type VerifyInput,
    type VerifyOutcome as RequestVerifyOutcome,
} from "./http-sig/verify.js"
export { signRequest, type SignOptions } from "./http-sig/sign.js"
export {
    parseSignature,
    parseSignatureInput,
    type InnerList,
} from "./http-sig/structured-fields.js"

// Server-issued challenges.
export {
    consumeChallenge,
    decodeBinding,
    encodeBinding,
    mintChallenge,
    nextChallengeHeaderValue,
    redeemChallenge,
    NEXT_CHALLENGE_HEADER,
    type ChallengeBinding,
    type ChallengeConfig,
    type ConsumeOutcome,
    type MintDeps,
    type MintedChallenge,
    type Realm,
} from "./challenge.js"
export {
    handleChallengeMint,
    withNextChallenge,
    type ChallengeEndpointDeps,
} from "./challenge-endpoint.js"

// The owner-facing surface.
export {
    authenticateOwner,
    type OwnerAuthDeps,
    type OwnerAuthOutcome,
} from "./owner/authenticate.js"
export {
    handleBlockSet,
    handleBlocksList,
    handleGrantDelete,
    handleGrantSet,
    handleGrantsCreate,
    handleGrantsList,
    handlePoolAdjudication,
    handlePoolList,
    handleRegistrationCreate,
    handleRegistrationDelete,
    handleRegistrationRead,
    type GrantConfig,
    type OwnerDeps,
} from "./owner/endpoints.js"

// The pair-put endpoint.
export { handlePairPut, type PairPutDeps } from "./pair-put"

// The grant-put endpoint.
export { handleGrantPut, type GrantPutDeps } from "./grant-put"

// The events socket's frame protocol and drain orchestration.
export {
    decodeAckFrame,
    decodeCapabilitiesFrame,
    decodeFrame,
    drainBacklog,
    encodeCapabilitiesFrame,
    encodeCaughtUpFrame,
    encodeDeliveryFrame,
    encodePoolFrame,
    handleAckFrame,
    type AckPayload,
    type DecodedFrame,
    type EffectiveCapabilities,
    type EventsDeps,
} from "./events"

// Sender authentication.
export {
    decodePairPutEnvelope,
    encodePairPutEnvelope,
    verifyPairPut,
    PAIR_PUT_TYPE_VERSION,
    type PairPutPayload,
    type VerifyOutcome,
} from "./cose/sign1"
export {
    encodeOkpEd25519Key,
    parseOkpEd25519Key,
    thumbprintOkpEd25519,
    type OkpEd25519Key,
} from "./cose/key"
export {
    decodeCoseArray,
    decodeCoseMap,
    decodeCoseSequence,
    encodeCose,
    type CoseValue,
} from "./cose/cbor"

// Declaration resolution and content addressing.
export { resolveDeclaration, type DeclarationResolution } from "./declaration"
// Shared with the key monitor: the SSRF guards are the security boundary
// for every consumer, so they are reused rather than reimplemented.
export {
    guardedFetchBytes,
    guardedFetchJSON,
    resolvePDSEndpoint,
} from "./atproto-fetch"
export { deriveMessageId } from "./message-id"

// Grant address and put-tag derivation.
export {
    computeGrantPutTag,
    deriveGrantAddress,
    verifyGrantPutTag,
} from "./grant"
export {
    readBodyCapped,
    toResponseBody,
    base64URLToBinary,
    binaryToBase64URL,
} from "./util"
