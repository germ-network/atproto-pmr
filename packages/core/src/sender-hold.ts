import type { AuthenticatedPutDeps } from "./authenticated-put.js"
import type { SenderDeclarationResolution } from "./declaration.js"
import { FIREHOSE_COVERAGE_MAX_LAG_MS } from "./firehose-coverage.js"
import type { PairMailboxKey } from "./storage.js"

/**
 * The hold for a sender whose put fails under the monitor's snapshot but
 * verifies under the declaration on the sender's own PDS: a device that just
 * published a new anchor key can message before the monitor has settled it.
 *
 * The PDS read only admits a put into the hold. Delivery happens only when
 * the monitor settles a declaration whose key verifies the held envelope, so
 * what reaches a mailbox still rests on the monitor's independent view
 * (`spec/trust-model.md`, P5).
 */

/**
 * How long a put waits for the monitor, and how long a settled declaration
 * is kept to bridge KV propagation. Chosen to match the bound past which the
 * monitor counts a DID as lagging (`spec/key-transparency.md`, "Lagging").
 */
export const SENDER_HOLD_TTL_SECONDS = FIREHOSE_COVERAGE_MAX_LAG_MS / 1000

/** Bound on one direct read of the sender's PDS; a slower PDS gets today's `409`. */
export const DIRECT_READ_TIMEOUT_MS = 3_000

/**
 * At most one completed direct read per sender in this window, so forged puts
 * naming a DID cannot each cost a read of its PDS, nor each tell that PDS a
 * put arrived.
 */
export const DIRECT_READ_MEMO_SECONDS = 60

/**
 * Isolate-wide bound on hold consultations for senders with no snapshot at
 * all, so forged puts naming fresh DIDs cannot each cost a directory read, a
 * PDS read and a hold object.
 */
export const UNSNAPSHOTTED_HOLD_CONSULTS_PER_MINUTE = 60

/** A per-minute budget: true while this minute has budget left, and spends one. */
export function perMinuteBudget(perMinute: number): (nowSeconds: number) => boolean {
    void perMinute
    return () => {
        throw new Error("perMinuteBudget: not implemented")
    }
}

/** A declaration that verified, as pair put ingests under it. */
export type VerifiedSenderDeclaration = Extract<SenderDeclarationResolution, { found: true }>

/**
 * A declaration read from the sender's PDS and verified (commit signature
 * under the DID document's `#atproto` key, record path through the commit's
 * tree), newer than the monitor's snapshot. Trusted only to admit puts into
 * the hold, never as evidence for delivery.
 */
export interface InterimDeclaration {
    /** Raw 32-byte Ed25519 anchor key, as `verifyPairPut` takes it. */
    anchorKey: Uint8Array
    declarationCID: string
    revision: string
    readAtSeconds: number
}

export interface HeldPairPut {
    recipientDID: string
    /** The signed pair-put bytes as received; re-verified at release. */
    envelope: Uint8Array
    /**
     * Hex of the envelope nonce; a repeat while held is absorbed. Scoped to
     * the sender across recipients, narrower than the relay's per-recipient
     * seen set; clients draw nonces at random.
     */
    nonceHex: string
    /** Revision of the interim declaration the put verified under. */
    heldUnderRevision: string
    heldAtSeconds: number
    expiresAtSeconds: number
}

export interface HoldRequest {
    recipientDID: string
    envelope: Uint8Array
    /** Revision of the monitor's snapshot, or null when none is held. A direct read must be newer. */
    snapshotRevision: string | null
    nowSeconds: number
}

export type HoldAdmission =
    /**
     * The monitor has settled a declaration newer than the snapshot the
     * caller read (its KV write not yet visible there) and the put verifies
     * under it: ingest under this declaration as for a snapshot.
     */
    | { outcome: "settled"; declaration: VerifiedSenderDeclaration }
    /** Held, a repeat of a held nonce, or signed for another recipient: all answer `202`. */
    | { outcome: "accepted" }
    /** The sender's hold is at its cap. `retryAfter` is absolute, in seconds. */
    | { outcome: "full"; retryAfter: number }
    /** Neither a settled nor an interim declaration verifies the put: today's `409`. */
    | { outcome: "unverifiable" }

/** One sender's hold, as the pair-put path reaches it. */
export interface SenderHold {
    admit(request: HoldRequest): Promise<HoldAdmission>
}

/**
 * Durable state of one sender's hold. Single-writer: the caller serializes
 * calls for a sender (a Durable Object per sender DID does).
 */
export interface SenderHoldStorage {
    /**
     * The monitor's last settled declaration for this sender, stored on every
     * settle. Used even past its TTL until swept: it is monitor-verified, and
     * the snapshot comparison and the mailbox watermark bound its staleness.
     */
    settled(): Promise<StoredSettledDeclaration | null>
    setSettled(value: StoredSettledDeclaration | null): Promise<void>
    interim(): Promise<InterimDeclaration | null>
    setInterim(value: InterimDeclaration | null): Promise<void>
    /** When the last direct read completed. */
    lastDirectReadAt(): Promise<number | null>
    setLastDirectReadAt(seconds: number): Promise<void>
    /** Held puts in arrival order. */
    held(): Promise<HeldPairPut[]>
    append(put: HeldPairPut): Promise<void>
    remove(nonceHexes: readonly string[]): Promise<void>
}

export interface AdmitToHoldDeps {
    senderDID: PairMailboxKey
    storage: SenderHoldStorage
    /**
     * The sender's declaration straight from its PDS (`directDeclarationResolver`).
     * Concurrent calls for one sender MUST share one read: a put arriving
     * while a read is in flight waits for it rather than meeting the memo.
     */
    readDirect: (senderDID: string) => Promise<SenderDeclarationResolution>
    /** Cap on held puts for this sender, across all recipients. */
    maxHeld: number
}

/**
 * Called only after the put failed under the monitor's snapshot. Lookup
 * order: the stored settled declaration (if newer than the snapshot), the
 * cached interim declaration, then at most once per
 * `DIRECT_READ_MEMO_SECONDS` the PDS. Verification comes first; nonce dedup
 * and the cap apply only to a put that verified. Nothing is held under a
 * revision no newer than the stored settled one, since no settle would
 * release it.
 */
export async function admitToHold(
    request: HoldRequest,
    deps: AdmitToHoldDeps
): Promise<HoldAdmission> {
    void request
    void deps
    throw new Error("admitToHold: not implemented")
}

/** The monitor's settled declaration (`SettledDeclaration` in the monitor package). */
export interface SettledSenderDeclaration {
    rev: string
    cid: string
    /** Already verified by the monitor; the release reads the anchor key from it. */
    car: Uint8Array
}

export interface StoredSettledDeclaration {
    declaration: VerifiedSenderDeclaration
    settledAtSeconds: number
}

/** `releaseHeld` awaits every task it hands to `defer` before it returns. */
export interface ReleaseDeps extends AuthenticatedPutDeps {
    senderDID: PairMailboxKey
    storage: SenderHoldStorage
}

export interface ReleaseSummary {
    /** Ingested under the settled declaration. */
    released: number
    /** Expired, not verifiable under a settled declaration at least as new, or not stored at ingest. */
    dropped: number
    /** Held under a newer revision than the one settled; still waiting. */
    kept: number
}

/**
 * The monitor settled `settled` for this sender (`null`: it disposed of the
 * DID). A CAR whose commit names another DID, whose rev is not `settled.rev`,
 * or whose record CID is not `settled.cid` releases and stores nothing, as
 * does a settle older than the stored one (settles may arrive out of order).
 * Otherwise the settled declaration is stored for `admitToHold`, on every
 * settle, since only it tells the hold a revision was already settled. Each
 * held put that verifies under the settled key is ingested with the settled
 * declaration as its evidence; a put that does not verify is dropped once the
 * settled revision is at least the one it was held under. A failed deferred
 * task is logged and does not stop the release.
 */
export async function releaseHeld(
    settled: SettledSenderDeclaration | null,
    deps: ReleaseDeps,
    nowSeconds: number
): Promise<ReleaseSummary> {
    void settled
    void deps
    void nowSeconds
    throw new Error("releaseHeld: not implemented")
}

/** Drops expired held puts and an expired interim or settled declaration. Returns the earliest remaining expiry, or null. */
export async function sweepExpiredHolds(
    storage: SenderHoldStorage,
    nowSeconds: number
): Promise<number | null> {
    void storage
    void nowSeconds
    throw new Error("sweepExpiredHolds: not implemented")
}
