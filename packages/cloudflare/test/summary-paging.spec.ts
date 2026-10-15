/**
 * The owner's summary route pages its changes, and the indices it keeps per
 * token survive any summary size the contact cap allows.
 */
import { describe, it } from "vitest"

describe("summary route paging", () => {
    it.todo("a first read with more changes than a page returns full, more, and a token")
    it.todo("reading since that token continues from what was delivered, not from current")
    it.todo("reading since the last page's token with nothing new returns that token, unchanged")
    it.todo("an owner with more contacts than the cap allows gets truncated set")
    it.todo("a page read since a more token replaces that token's slot, so paging does not evict other tokens")
    it.todo("a page read since a final token keeps it, for other devices")
})

describe("PMRObject summary index storage", () => {
    it.todo("an index larger than one 2 MB storage value round-trips")
    it.todo("dropping a token deletes every part of its index")
})
