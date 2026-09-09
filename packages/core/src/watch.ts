/**
 * The own-DID declaration watch (`spec/wire-api.md`, "A registration lives
 * while the anchor key stays in the DID's declaration"; `atproto-pmr.md`,
 * Lifecycle). A relay periodically re-checks the *registration owner's own*
 * Germ declaration; when the declared anchor key disappears it **pauses**
 * rather than tears down — DID-addressed mail stops, grant-addressed mail
 * continues, and it keeps watching that one declaration to see whether the
 * key returns.
 *
 * This module is the platform-neutral decision logic: pure functions over a
 * `DeclarationResolution` and the trusted key, folded into `WatchState`. The
 * scheduling that drives the re-check, and the admission-path enforcement of
 * `paused`, are the storage adapter's (see `PMRStore` and the Cloudflare
 * `PMRObject`).
 *
 * Rotation to a *different* key is out of scope here (GER-2212, Q-PMR-12):
 * today a changed key is treated the same as a disappeared one — pause — and
 * the pause "covers the gap either way" until rotation ships. State is keyed
 * by DID, never by key, so a rotation is not foreclosed.
 */

import type { DeclarationResolution } from "./declaration.js"
import { compareRev } from "./rev.js"
import type { WatchOutcome, WatchState } from "./storage.js"

export type { WatchOutcome, WatchState } from "./storage.js"

/**
 * Classify a re-check of the owner's own declaration against the key the relay
 * currently trusts for the registration.
 *
 * `present` requires BOTH that the declaration resolved AND that its key
 * equals `trustedKeyX`. A resolved-but-different key is `absent` (a rotation,
 * whose dedicated handling is deferred to GER-2212 — pausing is the interim
 * cover). A `found:false` result is `absent` only when the resolver
 * *confirmed* the key is gone; an unconfirmed (transient) failure is
 * `unknown`, so a PDS blip never pauses a healthy mailbox.
 *
 * `trustedKeyX` is the raw 32-byte Ed25519 public key (the `x` coordinate),
 * i.e. the trusted `RegistrationFields.anchorKey` decoded from its COSE blob.
 */
export function classifyDeclaration(
    resolution: DeclarationResolution,
    trustedKeyX: Uint8Array
): WatchOutcome {
    if (resolution.found) {
        return bytesEqual(resolution.anchorKey.x, trustedKeyX) ? "present" : "absent"
    }
    return resolution.confirmed === true ? "absent" : "unknown"
}

/** The state a never-checked registration reads as: live, unpaused. */
export const INITIAL_WATCH_STATE: WatchState = { paused: false, lastCheckAt: 0 }

/**
 * Fold one re-check outcome into watch state, under the monotonic-rev watermark.
 *
 * - `unknown` → leave `paused` exactly as it was; only stamp the check. A
 *   transient failure must move nothing: it neither pauses a live mailbox nor
 *   unpauses a genuinely-gone one (recovery is confirmed by a later `present`).
 * - a `present`/`absent` carrying an `observedRev` that is NOT strictly newer
 *   than `prev.lastObservedRev` → REFUSED: leave `paused`, only stamp. This is
 *   the watermark — a reordered/replayed recheck (Cloudflare Queues are
 *   unordered + at-least-once), or a PDS rev that moved *backwards* (a
 *   rollback), must not move a flag set from a fresher observation.
 * - otherwise → `present` unpauses, `absent` pauses; stamp, and advance
 *   `lastObservedRev` to `observedRev` when one was supplied.
 *
 * `observedRev` is omitted only when there was no rev to read (a fully-gone
 * repo). Such an apply is not watermark-gated — pausing is fail-safe — and does
 * not advance the watermark. `prev.lastObservedRev` absent (never checked, or a
 * row written before the field existed) is treated as "no floor": any rev
 * advances.
 *
 * RESIDUAL: because a rev-less pause leaves the floor untouched, a later
 * newer-than-the-stale-floor `present` wake could unpause against it if the PDS
 * serves stale on that re-fetch. Bounded (the next genuine recheck re-pauses)
 * and fail-safe (mail stays stored E2E, senders re-verify the declaration
 * themselves); the real defense against a PDS that serves stale/forged is the
 * client's monitor cross-check, not this relay-side gate (`spec/trust-model.md`).
 */
export function reconcileWatchState(
    prev: WatchState,
    outcome: WatchOutcome,
    nowSeconds: number,
    observedRev?: string
): WatchState {
    if (outcome === "unknown") {
        return { ...prev, lastCheckAt: nowSeconds }
    }
    if (
        observedRev !== undefined &&
        compareRev(prev.lastObservedRev ?? null, observedRev) !== "advanced"
    ) {
        return { ...prev, lastCheckAt: nowSeconds }
    }
    const next: WatchState = {
        paused: outcome === "absent",
        lastCheckAt: nowSeconds,
    }
    const carriedRev = observedRev ?? prev.lastObservedRev
    if (carriedRev !== undefined) next.lastObservedRev = carriedRev
    return next
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}
