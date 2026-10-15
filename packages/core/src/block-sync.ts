import type { BlockEdgeStore } from "./block-edges.js"
import { isPairMailboxKey } from "./mailbox-key.js"
import type { PMRStore } from "./storage.js"

/**
 * Bring the relay's mirror of the owner's Bsky blocks up to date before a
 * catch-up delivers anything, so mail from a sender the owner has since
 * blocked is cleared rather than delivered.
 *
 * A read slower than `BLOCK_SYNC_DEADLINE_MS` counts as a failed one, so a
 * slow monitor never stalls a catch-up.
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
    if (blocks === undefined) return
    try {
        const edges = await withDeadline(blocks.ownBlocks(owner), BLOCK_SYNC_DEADLINE_MS)
        if (edges === null) return
        const subjects = new Set<string>()
        for (const { subject } of edges) {
            if (isPairMailboxKey(subject) && keyFits(subject)) subjects.add(subject)
        }
        await store.syncBskyBlocks(subjects)
    } catch {}
}

const encoder = new TextEncoder()
/** Durable Object storage rejects keys over 2 KiB; leave room for the key-family prefix. */
const MAX_SUBJECT_BYTES = 2048 - 16
const keyFits = (subject: string) => encoder.encode(subject).byteLength <= MAX_SUBJECT_BYTES

/** Implementation-defined; past it the catch-up proceeds on the last-known blocks. */
export const BLOCK_SYNC_DEADLINE_MS = 2_000

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    let cancel = () => {}
    const deadline = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("block read timed out")), ms)
        cancel = () => clearTimeout(timer)
    })
    try {
        return await Promise.race([work, deadline])
    } finally {
        cancel()
    }
}
