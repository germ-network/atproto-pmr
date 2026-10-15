/**
 * The device can tell which relay blocks mirror Bsky, so it knows which
 * unblocks will hold and keeps them out of the block list it republishes.
 */
import { describe, it } from "vitest"

describe("GET /pmr/v1/blocks sources", () => {
    it.todo("b lists every blocked sender, as before")
    it.todo("bs lists the senders whose block mirrors a Bsky block")
})
