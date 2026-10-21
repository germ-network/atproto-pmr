/**
 * Registration lifecycle (`spec/wire-api.md`, "Registration lifecycle").
 *
 * The monitor verifying that the declaration names a different anchor or none
 * retires the DID's active registration: it is destroyed with its mail.
 * Registrations under different anchors are unrelated: nothing of one is
 * visible to another.
 */

import { parseOkpEd25519Key } from "./cose/key.js"
import type { Directory, Locator, PMRStore, VerifiedAnchorObservation } from "./storage.js"
import { bytesEqual } from "./watch.js"

/**
 * Applies one monitor-verified observation of the DID's declaration to its
 * active registration (`activeLocator`, anchor key `activeAnchorKey`, a
 * `COSE_Key` blob). The monitor's view can predate a registration made
 * against the live declaration, so the monitor first has to confirm this
 * registration's own anchor; until it has, nothing it reports retires
 * anything. After that, a different anchor or a verified absence retires the
 * registration, and the same anchor or `unknown` changes nothing. Never
 * resurrects anything.
 */
export async function applyVerifiedAnchorObservation(
    directory: Pick<Directory, "retire">,
    store: Pick<PMRStore, "isMonitorConfirmed" | "markMonitorConfirmed">,
    did: string,
    activeLocator: Locator,
    activeAnchorKey: Uint8Array,
    observation: VerifiedAnchorObservation
): Promise<"retired" | "unchanged"> {
    if (observation.state === "unknown") return "unchanged"
    if (observation.state === "present" && sameAnchor(activeAnchorKey, observation.anchorKey)) {
        await store.markMonitorConfirmed()
        return "unchanged"
    }
    if (!(await store.isMonitorConfirmed())) return "unchanged"
    const retired = await directory.retire(did, activeLocator)
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
