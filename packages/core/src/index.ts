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
    Locator,
    MailboxKey,
    MessageId,
    MessageRef,
    Nonce,
    PMRStore,
    PoolAppendResult,
    RegistrationFields,
    ResolvedAddress,
    VerificationHint,
} from "./storage"

// The blocked-sender seam. Supply your own; do not publish it.
export {
    DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR,
    type SyntheticAdvance,
    type SyntheticBehavior,
    type SyntheticState,
} from "./synthetic"

// Deployment parameters and the capability document generated from them.
export {
    buildCapabilityDocument,
    serveCapabilityDocument,
    SUPPORTED_API_VERSIONS,
    SUPPORTED_ENCODINGS,
    type CapabilityDocument,
    type PMRConfig,
    type PMRLimits,
    type PoolLimits,
    type ServedFunction,
} from "./config"

// The pair-put endpoint.
export { handlePairPut, type PairPutDeps } from "./pair-put"

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
    encodeCose,
    type CoseValue,
} from "./cose/cbor"

// Declaration resolution and content addressing.
export { resolveDeclaration, type DeclarationResolution } from "./declaration"
export { deriveMailboxKey, deriveMessageId } from "./message-id"
export { readBodyCapped, base64URLToBinary, binaryToBase64URL } from "./util"
