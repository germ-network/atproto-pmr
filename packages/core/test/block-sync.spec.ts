/**
 * Every catch-up first mirrors the owner's current Bsky blocks, so mail from a
 * sender blocked since it was accepted is cleared rather than delivered — and
 * a block the relay cannot see is never lifted.
 */
import { describe, it } from "vitest"

describe("syncOwnerBlocks", () => {
    it.todo("passes the subjects of the owner's ownBlocks to syncBskyBlocks")
    it.todo("skips subjects that are not DIDs or exceed the storage key limit")
    it.todo("does nothing without a blocks source")
    it.todo("does nothing when the owner's graph is not served (ownBlocks null)")
    it.todo("does nothing and does not throw when ownBlocks throws")
})

describe("catch-up mirrors blocks first", () => {
    it.todo("drainBacklog syncs before reading any mailbox, so a newly blocked sender's queue is not delivered")
    it.todo("GET /pmr/v1/messages syncs on the first page only (no cursor or an empty one)")
    it.todo("GET /pmr/v1/pool syncs before listing, so a bsky-blocked pooled sender is not listed")
})
