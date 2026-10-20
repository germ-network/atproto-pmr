/**
 * Registration lifecycle (`spec/wire-api.md`, "Registration lifecycle").
 *
 * A DID has at most one active registration. The monitor verifying that the
 * declaration names a different anchor or none retires it to inactive:
 * terminal, no new mail, its backlog kept unread until the retention
 * deadline and then destroyed. Registrations under different anchors are
 * unrelated: nothing of one is visible to another.
 */

import { parseOkpEd25519Key } from "./cose/key.js"
import type { Directory, Locator, PMRStore, VerifiedAnchorObservation } from "./storage.js"
import { bytesEqual } from "./watch.js"

/** How long an inactive registration's backlog is kept. The spec's floor is 30 days. */
export const INACTIVE_BACKLOG_RETENTION_SECONDS = 30 * 24 * 60 * 60

/**
 * Inactive registrations kept per DID; past it the oldest is destroyed early.
 */
export const MAX_INACTIVE_REGISTRATIONS = 4

/**
 * Applies one monitor-verified observation of the DID's declaration to its
 * active registration (`activeLocator`, anchor key `activeAnchorKey`, a
 * `COSE_Key` blob). The monitor's view can predate a registration made
 * against the live declaration, so the monitor first has to confirm this
 * registration's own anchor; until it has, nothing it reports retires
 * anything. After that, a different anchor or a verified absence retires the
 * registration, and the same anchor or `unknown` changes nothing. Never
 * reactivates anything.
 */
export async function applyVerifiedAnchorObservation(
    directory: Pick<Directory, "deactivate">,
    store: Pick<PMRStore, "isMonitorConfirmed" | "markMonitorConfirmed">,
    did: string,
    activeLocator: Locator,
    activeAnchorKey: Uint8Array,
    observation: VerifiedAnchorObservation,
    nowSeconds: number
): Promise<"retired" | "unchanged"> {
    if (observation.state === "unknown") return "unchanged"
    if (observation.state === "present" && sameAnchor(activeAnchorKey, observation.anchorKey)) {
        await store.markMonitorConfirmed()
        return "unchanged"
    }
    if (!(await store.isMonitorConfirmed())) return "unchanged"
    const retired = await directory.deactivate(did, nowSeconds, activeLocator)
    return retired === null ? "unchanged" : "retired"
}

// Keys compare by the parsed public key, not blob bytes: the two blobs are
// encoded on different paths. An unparseable blob never matches.
function sameAnchor(a: Uint8Array, b: Uint8Array): boolean {
    try {
        return bytesEqual(parseOkpEd25519Key(a).x, parseOkpEd25519Key(b).x)
    } catch {
        return false
    }
}
