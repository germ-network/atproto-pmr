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
    ExtensionFields,
    ExtensionValue,
    MessageRef,
    MonitorRegistrationNotify,
    MonitorRecheckRequest,
    MonitorVerifiedAnchorRequest,
    Nonce,
    OpenMailboxesPage,
    PairMailboxKey,
    PMRStore,
    PoolAppendResult,
    PoolSender,
    ReceiveResult,
    BlockSource,
    RegistrationFields,
    ResolvedAddress,
    VerificationHint,
    WatchState,
    VerifiedAnchorObservation,
} from "./storage"

export { applyVerifiedAnchorObservation } from "./registration-lifecycle"

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
    requestSignatureAlg,
    type RequestSignatureAlg,
    type VerifyInput,
    type VerifyOutcome as RequestVerifyOutcome,
} from "./http-sig/verify.js"
export { signRequest, type SignOptions, type SigningKey } from "./http-sig/sign.js"
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
    RegistrationFieldError,
    type CommittedRegistration,
    type OwnerDeps,
    type RegistrationExtension,
} from "./owner/endpoints.js"

// Receive-time admission and the Bsky block mirror.
export {
    ADMISSION_DEADLINE_MS,
    ADMISSION_UNAVAILABLE,
    admissionOf,
    admissionOrUnavailable,
    POLICY_NOT_ENABLED,
    RECIPIENT_NOT_HELD,
    type Admission,
    type AdmissionSource,
    type PoolVerdict,
} from "./admission"
export { syncOwnerBlocks } from "./block-sync"

// The pair-put endpoint.
export {
    handlePairPut,
    DECLARATION_RETRY_AFTER_SECONDS,
    type PairPutDeps,
} from "./pair-put"

// Storing a put whose sender was authenticated by other means.
export {
    ingestAuthenticatedPut,
    type AuthenticatedPut,
    type AuthenticatedPutDeps,
    type AuthenticatedPutOutcome,
} from "./authenticated-put"

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
    RESERVED_ENTRY_KEYS,
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
    encodeAkpMlDsa65Key,
    encodeCosePublicKey,
    encodeOkpEd25519Key,
    ML_DSA_65_PUBLIC_KEY_BYTES,
    parseAkpMlDsa65Key,
    parseCosePublicKey,
    parseOkpEd25519Key,
    thumbprintAkpMlDsa65,
    thumbprintCosePublicKey,
    thumbprintOkpEd25519,
    type AkpMlDsa65Key,
    type CosePublicKey,
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
    declarationAnchorKeyOf,
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
    guardedFetchStream,
    FetchTimeoutError,
    resolvePDSEndpoint,
    resolveSigningKey,
    fetchDidDocument,
    didWebDocumentURL,
    fetchPlcAuditLog,
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
    verifyRecordProofOutcome,
    readRecordFromCar,
    RepoProofError,
    type CarRecord,
    type RepoProofErrorCode,
    type RecordProofExpectation,
    type RecordProofOutcome,
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
    type RetainedBlocks,
    type RepoCollectionExpectation,
    type RepoCollectionsExpectation,
    type VerifiedCollection,
    type VerifiedCollections,
    verifyRepoCollections,
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
export {
    FIREHOSE_COVERAGE_MAX_LAG_MS,
    FIREHOSE_LAGGING_CAP,
    summaryCoverageAtMs,
    KV_VISIBILITY_MS,
    type FirehoseCoverage,
    type SummaryCoverageDeps,
} from "./firehose-coverage"

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
export { FOLLOW_COLLECTION_NSID, type FollowEdge, type FollowEdgeStore } from "./follow-edges"
export {
    BLOCK_COLLECTION_NSID,
    type BlockEdge,
    type BlockEdgeStore,
    type MonitorOwnBlocksRequest,
} from "./block-edges"
export {
    ownerGraph,
    type MonitorOwnGraphRequest,
    type OwnerGraph,
    type OwnerGraphEdge,
} from "./owner-graph"
export {
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
    OWN_BLOCK_KEYS,
    RECORD_READ_KEYS,
    type OwnBlock,
    type RecordReadMiss,
    type RecordReadResponse,
} from "./read-api"

// The device read API: the public record read, and the owner's summary.
export {
    decodeRecordReadResponse,
    dedupedRecheck,
    encodeRecordReadResponse,
    handleRecordRead,
    type RecordReadDeps,
} from "./device-read"
export {
    appendPlcLogEntry,
    parsePlcAuditLog,
    PlcLogError,
    verifyPlcCurrentKeyOperation,
    verifyPlcLog,
    type PlcLog,
    type PlcLogEntry,
} from "./plc-log"
export {
    decodeDidDocReadResponse,
    DID_DOC_READ_KEYS,
    encodeDidDocReadResponse,
    handleDidDocRead,
    PLC_COVERAGE_KEYS,
    PLC_LOG_ENTRY_KEYS,
    type DidDocReadDeps,
    type DidDocReadMiss,
    type DidDocReadResponse,
    type PlcLogStore,
} from "./did-doc-read"
export {
    readSigningKeyFrom,
    servableUnderRotation,
    type ReadSigningKey,
    type ReadSigningKeys,
} from "./read-signing-key"
export {
    buildSummaryIndex,
    readSummaryPage,
    summaryContacts,
    SummaryOwnerReadError,
    SUMMARY_MAX_RECORDS,
    SUMMARY_PAGE_RECORDS,
    CLOCK_DISCONTINUITY_HOLD_MS,
    CLOCK_DISCONTINUITY_THRESHOLD_MS,
    wallClockMonitor,
    type WallClockMonitor,
    type SummaryHeldEntry,
    type SummaryIndexReader,
    type SummaryPageDeps,
    decodeSummaryDelta,
    diffSummaryIndex,
    encodeSummaryDelta,
    SUMMARY_DELTA_KEYS,
    SUMMARY_RECORD_KEYS,
    SUMMARY_TOKENS_KEPT,
    type SummaryDelta,
    type SummaryIndex,
    type SummaryIndexEntry,
    type SummaryRecord,
    type SummaryRecordRef,
} from "./summary"
export type {
    DeclarationEvidenceIdentity,
    EvidenceAssurance,
    EvidenceAuthorityIdentity,
    SnapshotEvidence,
    SummaryEvidence,
} from "./summary-evidence-contract"
export {
    CAN_MESSAGE_KEYS,
    canMessageFromCose,
    canMessageToCose,
    computeCanMessage,
    computeCanMessageMany,
    declaredPoliciesOf,
    decodeCanMessageVerdict,
    encodeCanMessageVerdict,
    evaluateCanMessage,
    handleCanMessageRead,
    snapshotPolicySource,
    type AllowPolicy,
    type CanMessageFacts,
    type CanMessageNoReason,
    type CanMessageDeps,
    type CanMessageUnknownReason,
    type CanMessageVerdict,
    type DeclaredPolicies,
    type PairFact,
    type RecipientGraphFacts,
    type SenderGraphReader,
    type PolicySource,
    type SnapshotPolicySourceDeps,
} from "./can-message"
export { allowPoliciesOf, readAnchorPolicy, type AnchorPolicy } from "./anchor-policy"
export { type StoredPolicies } from "./policy"

export {
    indexPolicySource,
    SUMMARY_VERDICT_KEYS,
    type SummaryVerdict,
} from "./summary-verdicts"
