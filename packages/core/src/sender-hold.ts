import { ingestAuthenticatedPut, type AuthenticatedPutDeps } from "./authenticated-put.js"
import { parseOkpEd25519Key } from "./cose/key.js"
import { decodePairPutEnvelope, verifyPairPut } from "./cose/sign1.js"
import {
    DECLARATION_COLLECTION_NSID,
    declarationAnchorKeyOf,
    type SenderDeclarationResolution,
} from "./declaration.js"
import { FIREHOSE_COVERAGE_MAX_LAG_MS } from "./firehose-coverage.js"
import { readRecordFromCar } from "./repo-proof.js"
import { compareRev } from "./rev.js"
import type { PairMailboxKey } from "./storage.js"
import { errorKind } from "./log-safe"
import { notifyIntakeStored } from "./intake-hook.js"

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
    let minute = -1
    let spent = 0
    return (nowSeconds) => {
        const current = Math.floor(nowSeconds / 60)
        if (current !== minute) {
            minute = current
            spent = 0
        }
        if (spent >= perMinute) return false
        spent += 1
        return true
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
     * the sender across recipients, coarser than the relay's per-recipient
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
 * calls for a sender (a Durable Object per sender DID does), except that puts
 * resuming from one shared read are serialized by `admitToHold` itself.
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
    /** The same object for every call for this sender: it keys the critical section that enforces the cap. */
    storage: SenderHoldStorage
    /**
     * The sender's declaration straight from its PDS (`directDeclarationResolver`).
     * Concurrent calls for one sender MUST share one read: a put arriving
     * while a read is in flight waits for it rather than meeting the memo.
     */
    readDirect: (senderDID: string) => Promise<SenderDeclarationResolution>
    /** Cap on held puts for this sender, across all recipients; at least 1. */
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
    let envelope: ReturnType<typeof decodePairPutEnvelope>
    try {
        envelope = decodePairPutEnvelope(request.envelope)
    } catch {
        return { outcome: "unverifiable" }
    }
    if (envelope.payload.senderDID !== deps.senderDID) return { outcome: "unverifiable" }
    const { storage } = deps
    const now = request.nowSeconds

    const settledVerdict = async (): Promise<HoldAdmission | null> => {
        const settled = await storage.settled()
        if (settled === null) return null
        const declaration = settled.declaration
        if (compareRev(request.snapshotRevision, declaration.revision) !== "advanced") return null
        const outcome = verifyPairPut(envelope, declaration.anchorKey.x, request.recipientDID)
        if (outcome.valid) return { outcome: "settled", declaration }
        return outcome.code === "recipient" ? { outcome: "accepted" } : null
    }

    const settledFirst = await settledVerdict()
    if (settledFirst !== null) return settledFirst

    const viaInterim = async (interim: InterimDeclaration): Promise<HoldAdmission | null> => {
        const outcome = verifyPairPut(envelope, interim.anchorKey, request.recipientDID)
        if (outcome.valid) return holdVerified(request, envelope, interim, deps)
        return outcome.code === "recipient" ? { outcome: "accepted" } : null
    }

    const settledRevision = (await storage.settled())?.declaration.revision ?? null
    const cached = await storage.interim()
    if (
        cached !== null &&
        now - cached.readAtSeconds < SENDER_HOLD_TTL_SECONDS &&
        compareRev(request.snapshotRevision, cached.revision) === "advanced" &&
        compareRev(settledRevision, cached.revision) === "advanced"
    ) {
        const verdict = await viaInterim(cached)
        if (verdict !== null) return verdict
    }

    const lastRead = await storage.lastDirectReadAt()
    if (lastRead !== null && now - lastRead < DIRECT_READ_MEMO_SECONDS) {
        return { outcome: "unverifiable" }
    }
    const read = await deps.readDirect(deps.senderDID)
    await storage.setLastDirectReadAt(now)
    if (!read.found) return { outcome: "unverifiable" }

    const settledAfterRead = await settledVerdict()
    if (settledAfterRead !== null) return settledAfterRead
    const settledRevisionAfterRead = (await storage.settled())?.declaration.revision ?? null
    if (
        compareRev(request.snapshotRevision, read.revision) !== "advanced" ||
        compareRev(settledRevisionAfterRead, read.revision) !== "advanced"
    ) {
        return { outcome: "unverifiable" }
    }
    const interim: InterimDeclaration = {
        anchorKey: read.anchorKey.x,
        declarationCID: read.declarationCID,
        revision: read.revision,
        readAtSeconds: now,
    }
    await storage.setInterim(interim)
    return (await viaInterim(interim)) ?? { outcome: "unverifiable" }
}

const lockTails = new WeakMap<object, Promise<unknown>>()

/** Runs `work` after every earlier call for the same `key` has finished. */
function serialized<T>(key: object, work: () => Promise<T>): Promise<T> {
    const result = (lockTails.get(key) ?? Promise.resolve()).then(work, work)
    lockTails.set(key, result.catch(() => {}))
    return result
}

/**
 * Holds a put that verified under `interim`: absorbed if its nonce is already
 * held, refused at the cap, else appended. The check and the append are one
 * critical section, because puts that shared a direct read resume together.
 */
function holdVerified(
    request: HoldRequest,
    envelope: ReturnType<typeof decodePairPutEnvelope>,
    interim: InterimDeclaration,
    deps: AdmitToHoldDeps
): Promise<HoldAdmission> {
    const nonceHex = Array.from(envelope.payload.nonce, (b) => b.toString(16).padStart(2, "0")).join("")
    return serialized(deps.storage, async () => {
        const held = await deps.storage.held()
        if (held.some((put) => put.nonceHex === nonceHex)) return { outcome: "accepted" }
        if (held.length >= deps.maxHeld) {
            const retryAfter = Math.min(...held.map((put) => put.expiresAtSeconds))
            return { outcome: "full", retryAfter }
        }
        await deps.storage.append({
            recipientDID: request.recipientDID,
            envelope: request.envelope,
            nonceHex,
            heldUnderRevision: interim.revision,
            heldAtSeconds: request.nowSeconds,
            expiresAtSeconds: request.nowSeconds + SENDER_HOLD_TTL_SECONDS,
        })
        return { outcome: "accepted" }
    })
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
    const { storage, senderDID } = deps
    const summary: ReleaseSummary = { released: 0, dropped: 0, kept: 0 }

    if (settled === null) {
        const held = await storage.held()
        await storage.remove(held.map((put) => put.nonceHex))
        await storage.setInterim(null)
        await storage.setSettled(null)
        summary.dropped = held.length
        return summary
    }

    let car: ReturnType<typeof readRecordFromCar> = null
    try {
        car = readRecordFromCar(settled.car, DECLARATION_COLLECTION_NSID, "self")
    } catch {}
    const stored = await storage.settled()
    if (
        car === null ||
        car.did !== senderDID ||
        car.rev !== settled.rev ||
        car.cid !== settled.cid ||
        (stored !== null && compareRev(stored.declaration.revision, settled.rev) === "regressed")
    ) {
        if (car === null || car.did !== senderDID || car.rev !== settled.rev || car.cid !== settled.cid) {
            console.warn("sender hold: ignoring a settled declaration that does not match its sender")
        }
        summary.kept = (await storage.held()).length
        return summary
    }

    let anchorKey: Uint8Array | null = null
    const keyBlob = declarationAnchorKeyOf(car.record)
    if (keyBlob !== null) {
        try {
            anchorKey = parseOkpEd25519Key(keyBlob).x
        } catch {}
    }
    if (anchorKey !== null) {
        await storage.setSettled({
            declaration: {
                found: true,
                anchorKey: { x: anchorKey },
                declarationCID: settled.cid,
                revision: settled.rev,
                evidenceCAR: settled.car,
            },
            settledAtSeconds: nowSeconds,
        })
    }

    const interim = await storage.interim()
    if (interim !== null && compareRev(interim.revision, settled.rev) !== "regressed") {
        await storage.setInterim(null)
    }

    const tasks: Promise<unknown>[] = []
    // The observer goes to the caller's own `defer`, not `tasks`: it is never
    // awaited here, so a slow one cannot hold up the release.
    const { onIntakeStored } = deps
    const ingestDeps: AuthenticatedPutDeps = {
        ...deps,
        defer: (work) => void tasks.push(work),
        onIntakeStored:
            onIntakeStored && ((at) => notifyIntakeStored(onIntakeStored, deps.defer, at)),
    }
    const processed: string[] = []
    for (const put of await storage.held()) {
        if (put.expiresAtSeconds <= nowSeconds) {
            processed.push(put.nonceHex)
            summary.dropped += 1
            continue
        }
        let verdict: "verifies" | "fails" | "undecodable" = "undecodable"
        let envelope: ReturnType<typeof decodePairPutEnvelope> | null = null
        try {
            envelope = decodePairPutEnvelope(put.envelope)
        } catch {}
        if (envelope !== null && anchorKey !== null) {
            verdict = verifyPairPut(envelope, anchorKey, put.recipientDID).valid ? "verifies" : "fails"
        } else if (envelope !== null) {
            verdict = "fails"
        }
        if (verdict === "verifies" && envelope !== null && anchorKey !== null) {
            try {
                const result = await ingestAuthenticatedPut(
                    {
                        recipientDID: put.recipientDID,
                        senderDID,
                        declarationCID: settled.cid,
                        payload: envelope.payload.payload,
                        replayKey: envelope.payload.nonce,
                        evidence: {
                            senderDID,
                            anchorKey,
                            declarationCID: settled.cid,
                            revision: settled.rev,
                            car: settled.car,
                            expiresAt: nowSeconds + deps.config.limits.messageExpirySeconds,
                        },
                    },
                    ingestDeps,
                    nowSeconds
                )
                processed.push(put.nonceHex)
                if (result.outcome === "accepted") summary.released += 1
                else summary.dropped += 1
            } catch (error) {
                console.error("sender hold: release of a held put failed", errorKind(error))
                summary.kept += 1
            }
        } else if (verdict === "undecodable" || compareRev(put.heldUnderRevision, settled.rev) !== "regressed") {
            processed.push(put.nonceHex)
            summary.dropped += 1
        } else {
            summary.kept += 1
        }
    }
    for (const outcome of await Promise.allSettled(tasks)) {
        if (outcome.status === "rejected") {
            console.error("sender hold: deferred work for a released put failed", errorKind(outcome.reason))
        }
    }
    await storage.remove(processed)
    return summary
}

/** Drops expired held puts and an expired interim or settled declaration. Returns the earliest remaining expiry, or null. */
export async function sweepExpiredHolds(
    storage: SenderHoldStorage,
    nowSeconds: number
): Promise<number | null> {
    const held = await storage.held()
    const expired = held.filter((put) => put.expiresAtSeconds <= nowSeconds)
    if (expired.length > 0) await storage.remove(expired.map((put) => put.nonceHex))
    const expiries = held.filter((put) => put.expiresAtSeconds > nowSeconds).map((put) => put.expiresAtSeconds)

    const interim = await storage.interim()
    if (interim !== null) {
        const expiresAt = interim.readAtSeconds + SENDER_HOLD_TTL_SECONDS
        if (expiresAt <= nowSeconds) await storage.setInterim(null)
        else expiries.push(expiresAt)
    }
    const settled = await storage.settled()
    if (settled !== null) {
        const expiresAt = settled.settledAtSeconds + SENDER_HOLD_TTL_SECONDS
        if (expiresAt <= nowSeconds) await storage.setSettled(null)
        else expiries.push(expiresAt)
    }
    return expiries.length === 0 ? null : Math.min(...expiries)
}
