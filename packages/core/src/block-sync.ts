import type { BlockEdgeStore } from "./block-edges.js"
import type { PMRStore } from "./storage.js"

/**
 * Bring the relay's mirror of the owner's Bsky blocks up to date before a
 * catch-up delivers anything, so mail from a sender the owner has since
 * blocked is cleared rather than delivered.
 *
 * Never throws and never lifts a block it cannot see: with no source, an
 * owner whose graph is not served (`ownBlocks` null), or a failed read, the
 * mirror is left as it was and delivery proceeds on the last-known blocks.
 * Subjects that are not DIDs a storage key can hold are skipped, so one bad
 * row cannot fail every sync.
 */
export async function syncOwnerBlocks(
    store: PMRStore,
    owner: string,
    blocks: Pick<BlockEdgeStore, "ownBlocks"> | undefined
): Promise<void> {
    throw new Error("not implemented")
}
