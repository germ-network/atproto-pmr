import { admitsThroughBoundedPolicy, POLICY_NOT_ENABLED, type CanMessageVerdict } from "./can-message.js"

export { admitsThroughBoundedPolicy, POLICY_NOT_ENABLED }

/**
 * Receive-time admission: whether a hosted recipient accepts a pair put from
 * a sender, decided by the relay when the put arrives so devices never
 * recompute it. The recipient's declared allow policies and Bsky social
 * graph decide yes or no; a Bsky block by the recipient is its own verdict,
 * because it is applied as a relay block rather than a pool entry.
 *
 * Grant-addressed puts are never adjudicated: a grant put names nobody, so
 * there is no sender to judge.
 */

/** Unknown reason when no verdict could be read in time (no source bound, the read failed, or the deadline passed). */
export const ADMISSION_UNAVAILABLE = "admission-unavailable"

export type Admission =
    /** The recipient's policy admits the sender: deliver this put. */
    | { verdict: "yes" }
    /** The policy refuses the sender: pool the put with `why`, for the device to judge. */
    | { verdict: "no"; why: readonly string[] }
    /** The relay cannot decide yet: pool the put with `why`. */
    | { verdict: "unknown"; why: readonly string[] }
    /**
     * The recipient blocks the sender on Bsky: mirror into the relay block.
     * Only `yes` proves there is no such block; `no` and `unknown` may hide
     * one the relay could not read.
     */
    | { verdict: "blocked" }

/** The verdict a pooled sender's latest put carried, listed to the device. */
export interface PoolVerdict {
    verdict: "no" | "unknown"
    why: readonly string[]
}

/**
 * Where a pair put's admission comes from. May throw; callers go through
 * `admissionOrUnavailable`, so a failed read pools rather than failing the put.
 */
export interface AdmissionSource {
    admission(sender: string, recipient: string): Promise<Admission>
}

/**
 * How long a put waits for its verdict. Implementation-defined; past it the
 * put pools as unknown rather than stalling on a slow read.
 */
export const ADMISSION_DEADLINE_MS = 1_000

/**
 * `source`'s verdict, or unknown[`ADMISSION_UNAVAILABLE`] when it throws or
 * misses `deadlineMs`. Never throws, and clears its timer once settled. A
 * missed read is abandoned, not cancelled.
 */
export async function admissionOrUnavailable(
    source: AdmissionSource,
    sender: string,
    recipient: string,
    deadlineMs: number = ADMISSION_DEADLINE_MS
): Promise<Admission> {
    const unavailable: Admission = {
        verdict: "unknown",
        why: [ADMISSION_UNAVAILABLE],
    }
    let cancel = () => {}
    const deadline = new Promise<Admission>((resolve) => {
        const timer = setTimeout(() => resolve(unavailable), deadlineMs)
        cancel = () => clearTimeout(timer)
    })
    try {
        return await Promise.race([
            source.admission(sender, recipient).catch(() => unavailable),
            deadline,
        ])
    } catch {
        return unavailable
    } finally {
        cancel()
    }
}

/** Unknown reason when the relay holds no declaration snapshot for the recipient. */
export const RECIPIENT_NOT_HELD = "recipient-not-held"
/**
 * The relay's reading of a can-message verdict, with the put's signed sender
 * as sender and the hosted owner as recipient. A no that names `blocked`
 * becomes `blocked`; a yes admitted only by `open` is held back as unknown
 * (`admitsThroughBoundedPolicy`), which `evaluateCanMessage` already applies.
 */
export function admissionOf(verdict: CanMessageVerdict | null): Admission {
    if (verdict === null) return { verdict: "unknown", why: [RECIPIENT_NOT_HELD] }
    switch (verdict.verdict) {
        case "no":
            return verdict.why.includes("blocked")
                ? { verdict: "blocked" }
                : { verdict: "no", why: verdict.why }
        case "unknown":
            return { verdict: "unknown", why: verdict.why }
        case "yes":
            return admitsThroughBoundedPolicy(verdict.via)
                ? { verdict: "yes" }
                : { verdict: "unknown", why: [POLICY_NOT_ENABLED] }
    }
}
