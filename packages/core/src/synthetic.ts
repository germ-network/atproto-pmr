/**
 * The synthetic-mailbox seam.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  The behavior a blocked sender observes is NOT shipped in this package,
 *  and the specification asks you not to publish yours either.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A blocked sender MUST NOT be able to distinguish being blocked from being
 * unanswered (`spec/trust-model.md` P4). The specification pins the
 * *requirements* on that behavior and deliberately not the behavior itself:
 * a published simulation is a fingerprint an attacker can test a relay
 * against. If every relay drains on the same published rhythm, observing
 * that rhythm identifies the implementation, and observing a departure from
 * it identifies a block.
 *
 * So this is an interface, not an implementation. A deployment supplies its
 * own and keeps it to itself. `DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR` below
 * exists so tests and local development have something to run against; it
 * is deliberately inadequate and says so.
 *
 * ## What an implementation MUST satisfy
 *
 * 1. **Synthetic.** Generated independently of the recipient's actual
 *    activity. It MUST NOT mirror, sample, or derive from the recipient's
 *    real reads, drains, or presence — a real mailbox's fill-and-drain *is*
 *    the recipient's behavior, and a blocked sender is exactly who must
 *    stop seeing it.
 *
 * 2. **No storage, no delivery.** State stays small and holds no message
 *    bytes; nothing here may produce a queue entry, a socket frame, or a
 *    push. The caller enforces the bytes half via `persistBody: false`.
 *
 * 3. **Timing parity.** Evaluation runs on the same code path as a real
 *    append and must not be observably cheaper. Do not add an early return
 *    that skips work.
 *
 * 4. **One distribution for both paths.** `nextRetryInstant` supplies the
 *    `Retry-After` hint for *every* refusal, genuinely full or synthetic.
 *    If the two draw from different distributions, a single `429`
 *    observation tells an attacker which population they are in and the
 *    simulation is defeated from the outside. A real mailbox's true
 *    next-available-slot time is event-driven — it frees when the recipient
 *    acks — so its `Retry-After` was always fabricated; fabricating both
 *    from one source costs nothing and closes the gap.
 *
 * 5. **Stable until it passes.** A sender who keeps pushing after a refusal
 *    must not be able to move the hint, on either path. Recomputing per
 *    request lets a polling sender sample the distribution repeatedly, and
 *    the refresh behavior itself becomes a signal.
 *
 * 6. **Anchor on the drain, not the fill.** If state resets on a schedule,
 *    derive the next reset from the previous *reset*, never from the last
 *    arrival — otherwise a persistent sender pushes the deadline back
 *    indefinitely, which is both wrong and a tell.
 *
 * It MAY change over time, including stochastically, and SHOULD differ
 * between deployments. Two conforming relays are not expected to behave
 * alike.
 */

/**
 * Opaque per-sender state. The storage layer persists whatever is returned
 * and hands it back unchanged; it never inspects the contents.
 *
 * Keep it small — it is written on every put from a blocked sender.
 */
export type SyntheticState = Record<string, number>

export interface SyntheticAdvance {
    /** Persisted verbatim and handed back on the next call. */
    state: SyntheticState
    /**
     * Whether this put is *presented* as accepted. `false` produces the
     * same `429` + `Retry-After` a genuinely full mailbox produces. Either
     * way no bytes are stored and nothing is delivered.
     */
    accepted: boolean
}

export interface SyntheticBehavior {
    /**
     * The `Retry-After` instant for ANY refusal — real or synthetic.
     *
     * @param stored the instant returned by a previous call, if still in
     *   the future. Return it unchanged to satisfy requirement 5.
     * @param nowSeconds seconds since the epoch.
     * @returns an absolute instant, seconds since the epoch.
     */
    nextRetryInstant(stored: number | undefined, nowSeconds: number): number

    /**
     * Advance the synthetic state for one arriving put.
     *
     * @param stored state from the previous call. On the first put after a
     *   sender is blocked this is an **empty object**, not `undefined`: the
     *   storage layer writes an empty state as its blocked marker rather
     *   than calling `advance` at block time, since seeding that way would
     *   count a fill the sender never sent. Handle both.
     * @param capacity the same per-sender capacity a real mailbox uses, so
     *   the synthetic mailbox refuses at a plausible point.
     * @param retryInstant what `nextRetryInstant` returned for this sender,
     *   so a drain-style implementation can align to it.
     */
    advance(
        stored: SyntheticState | undefined,
        nowSeconds: number,
        capacity: number,
        retryInstant: number
    ): SyntheticAdvance
}

/**
 * ⚠️ DEVELOPMENT AND TESTS ONLY — NOT FIT TO DEPLOY. ⚠️
 *
 * A fixed interval, which requirement 6 calls out as clockwork: any sender
 * who measures it learns immediately that they are talking to an unmodified
 * default. It is written this way deliberately — a plausible-looking
 * default would be worse, because it would ship unexamined.
 *
 * Supply your own `SyntheticBehavior` in production, and do not publish it.
 */
export const DEVELOPMENT_ONLY_SYNTHETIC_BEHAVIOR: SyntheticBehavior = {
    nextRetryInstant(stored, nowSeconds) {
        if (stored !== undefined && stored > nowSeconds) return stored
        return nowSeconds + 3600
    },

    advance(stored, nowSeconds, capacity, retryInstant) {
        const fill = stored?.fill ?? 0
        const resetAt = stored?.resetAt ?? retryInstant

        if (nowSeconds >= resetAt) {
            return { state: { fill: 1, resetAt: retryInstant }, accepted: true }
        }
        if (fill >= capacity) {
            return { state: { fill, resetAt }, accepted: false }
        }
        return { state: { fill: fill + 1, resetAt }, accepted: true }
    },
}
