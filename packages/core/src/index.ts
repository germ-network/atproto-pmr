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
    MonitorRegistrationNotify,
    Nonce,
    OpenMailboxesPage,
    PairMailboxKey,
    PMRStore,
    PoolAppendResult,
    PoolSender,
    RegistrationFields,
    ResolvedAddress,
    VerificationHint,
    WatchState,
} from "./storage"

// The own-DID declaration watch — pause-not-teardown decision logic.
export {
    classifyDeclaration,
    reconcileWatchState,
    INITIAL_WATCH_STATE,
    type WatchOutcome,
} from "./watch"

// Repo-revision comparison, shared by the monitor's rev index and the watch.
export { compareRev, type RevComparison } from "./rev"

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
    parseVapidPublicKey,
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
    handleMessagesAcks,
    handleMessagesList,
    handleSummaryRead,
    handlePoolAdjudication,
    handlePoolList,
    handleRegistrationCreate,
    handleRegistrationDelete,
    handleRegistrationRead,
    type GrantConfig,
    type MessagesConfig,
    type OwnerDeps,
} from "./owner/endpoints.js"

// The pair-put endpoint.
export {
    handlePairPut,
    DECLARATION_RETRY_AFTER_SECONDS,
    type PairPutDeps,
} from "./pair-put"

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
export {
    DECLARATION_COLLECTION_NSID,
    resolveDeclaration,
    resolveDeclarationWithRev,
    snapshotDeclarationResolver,
    type DeclarationSnapshot,
    type DeclarationResolution,
    type SenderDeclarationResolution,
    type SnapshotDeclarationDeps,
    type DeclarationWithRev,
} from "./declaration"
// Shared with the key monitor: the SSRF guards are the security boundary
// for every consumer, so they are reused rather than reimplemented.
export {
    fetchLatestRev,
    guardedFetchBytes,
    guardedFetchJSON,
    resolvePDSEndpoint,
    resolveSigningKey,
    fetchDidDocument,
    pdsResolutionFromDocument,
    extractSigningKey,
    fetchRecordProofCar,
    cachedSigningKeyResolver,
    SIGNING_KEY_TTL_MS,
    SIGNING_KEY_MAX_STALE_MS,
    type CachedSigningKey,
    type SigningKeyCache,
    RecordNotFoundError,
    type PDSResolution,
} from "./atproto-fetch"
export { deriveMessageId } from "./message-id"

// Grant address and put-tag derivation.
export {
    computeGrantPutTag,
    deriveGrantAddress,
    verifyGrantPutTag,
} from "./grant"
export {
    BodyTooLargeError,
    readBodyCapped,
    toResponseBody,
    base64URLToBinary,
    binaryToBase64URL,
} from "./util"

// Web Push delivery.
export {
    PushPayloadTooLargeError,
    SEAL_OVERHEAD_BYTES,
    sealPushPayload,
    type SealPushPayloadOptions,
} from "./push/seal"
export {
    signVapidJWT,
    vapidAuthorizationHeader,
    type SignVapidJwtOptions,
} from "./push/vapid"
export {
    deliverPush,
    type DeliverPushOptions,
    type DeliverPushResult,
} from "./push/deliver"
export {
    buildDeclarationPushPayload,
    buildMessagePushPayload,
    buildPoolPushPayload,
    type BuildMessagePushPayloadOptions,
} from "./push/payload"

// Single-record repo proofs (CAR + commit signature + MST path).
export {
    verifyRecordProof,
    readRecordFromCar,
    RepoProofError,
    type CarRecord,
    type RepoProofErrorCode,
    type RecordProofExpectation,
    type VerifiedRecord,
} from "./repo-proof"

// Every record of one collection from a whole-repo CAR, under the signing key.
export {
    verifyRepoCollection,
    RepoCollectionError,
    DEFAULT_MAX_REPO_BYTES,
    DEFAULT_MAX_MST_NODES,
    type CollectionRecord,
    type RepoCollectionErrorCode,
    type RepoCollectionExpectation,
    type VerifiedCollection,
} from "./repo-collection"

// The stored DID document a key monitor keeps per watched DID.
export {
    renderPlcDocument,
    storedSigningKeyResolver,
    STORED_DID_DOCUMENT_MAX_AGE_MS,
    PLC_COVERAGE_MAX_LAG_MS,
    type PlcCoverage,
    type StoredSigningKeyResolverDeps,
} from "./did-document"

// A verified read of one record from a third party's snapshot (24 h rule included).
export {
    snapshotRecordReader,
    SNAPSHOT_MAX_AGE_MS,
    type RecordSnapshot,
    type RecordSnapshotStore,
    type StoredRecordSnapshot,
    type SnapshotRecordRead,
    type SnapshotRecordReaderDeps,
} from "./snapshot-read"

// The proxy cache's stores, what a monitor watches, and the device read API's bodies.
export { type FollowEdge, type FollowEdgeStore } from "./follow-edges"
export {
    type GraphChangeLog,
    type GraphChangeReason,
    type GraphChangeRow,
    type InterestReader,
} from "./graph"
export {
    type CachedDidDocument,
    type DidDocument,
    type DidDocumentCache,
    type DidDocumentSource,
    type DidService,
    type DidVerificationMethod,
} from "./did-document"
export {
    parseInterestPolicy,
    parseMonitorCollections,
    type InterestPolicy,
    type WatchedCollection,
    type WatchedDidSet,
    type WatchedRecord,
} from "./watched"
export {
    GRAPH_EDGE_KEYS,
    GRAPH_READ_KEYS,
    RECORD_READ_KEYS,
    type GraphEdge,
    type GraphReadResponse,
    type RecordReadMiss,
    type RecordReadResponse,
} from "./read-api"

// The device read API: public record and graph reads, and the owner's summary.
export {
    decodeGraphReadResponse,
    decodeRecordReadResponse,
    dedupedRecheck,
    encodeGraphReadResponse,
    encodeRecordReadResponse,
    handleGraphRead,
    handleRecordRead,
    projectGraph,
    type GraphProjectionStore,
    type GraphProjectionWriter,
    type GraphReadDeps,
    type RecordReadDeps,
} from "./device-read"
export {
    buildSummary,
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    SUMMARY_DELTA_KEYS,
    SUMMARY_RECORD_KEYS,
    SUMMARY_TOKENS_KEPT,
    type SummaryDelta,
    type SummaryDeps,
    type SummaryIndex,
    type SummaryIndexEntry,
    type SummaryRecord,
    type SummaryRecordRef,
} from "./summary"
