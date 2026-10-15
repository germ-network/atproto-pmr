/**
 * The owner's Bsky blocks are mirrored into the relay block: a blocked sender's
 * queued and pooled mail is cleared and their puts go synthetic, a Bsky unblock
 * lifts only what the mirror set, and a device block always stands.
 */
import { describe, it } from "vitest"

describe("PMRObject Bsky block mirror", () => {
    it.todo("block with source bsky sets the marker, clears queue and pool, and lists the sender in listBlocked and listBskyBlocked")
    it.todo("syncBskyBlocks blocks a sender in the set the relay holds a mailbox or pool entry for")
    it.todo("syncBskyBlocks does not create a marker for a sender the relay holds nothing for")
    it.todo("syncBskyBlocks lifts a bsky marker whose sender left the set")
    it.todo("syncBskyBlocks never lifts a device marker")
    it.todo("a device block of a bsky-mirrored sender takes ownership, so leaving the set does not lift it")
    it.todo("a bsky block of a device-blocked sender leaves the device marker as it is")
    it.todo("a device unblock while the bsky block stands is re-blocked by the sender's next put")
    it.todo("clearing leaves message bodies to their TTL")
})

describe("PMRObject catch-up wiring", () => {
    it.todo("the events socket drain mirrors the owner's blocks from MONITOR_INGEST before delivering")
    it.todo("a missing or failing monitor still drains, on last-known blocks")
})
