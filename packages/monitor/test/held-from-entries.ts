import { DECLARATION_COLLECTION_NSID, readRecordFromCar } from "@germ-network/atproto-pmr-core"
import type { HeldDeclarationState, HeldStateIndex, SnapshotEntry } from "../src/storage"

function recordCidOf(e: SnapshotEntry): string {
    try {
        return readRecordFromCar(e.car, DECLARATION_COLLECTION_NSID, "self")?.cid ?? e.cid ?? ""
    } catch {
        return e.cid ?? ""
    }
}

/**
 * The held-state half of a fake index, derived from the entries a fake
 * snapshot store holds, so a test that seeds an entry also seeds the writer's
 * state. Tests that need the two to disagree build their own.
 */
export function heldFromEntries(
    entries: Map<string, SnapshotEntry>,
    seenKeys: Map<string, string> = new Map()
): HeldStateIndex {
    return {
        heldDeclarationOf: async (did): Promise<HeldDeclarationState | null> => {
            const e = entries.get(did)
            if (e === undefined) return null
            return {
                rev: e.rev,
                cid: recordCidOf(e),
                verifiedWith: e.verifiedWith ?? e.signingKey ?? "",
                commitCid: e.commitCid ?? null,
                anchorKey: null,
                messagingKeyFingerprint: e.messagingKeyFingerprint ?? null,
                messagingKeyFirstSeenAtMs: e.messagingKeyFirstSeenAtMs ?? null,
                seenKey: seenKeys.get(did) ?? e.seenKey ?? null,
            }
        },
        recordSeenKey: async (did, key) => void seenKeys.set(did, key),
    }
}
