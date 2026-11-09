/**
 * A blocked sender meets the reservation it would reach unblocked, so the
 * point where a 429 starts cannot tell it that it is blocked.
 */
import { describe, it } from "vitest"

describe("synthetic capacity follows the tier", () => {
    it.todo("refuses a device-blocked sender judged no at the request depth")
    it.todo("refuses a device-blocked sender judged yes at the pair depth")
    it.todo("refuses a Bsky-blocked sender at the request depth")
    it.todo("refuses a blocked sender on the no-admission path at the request depth")
    it.todo("blocking a sender clears its request entries and refunds their bytes")
    it.todo("syncBskyBlocks blocks a Bsky-blocked sender that holds only request entries")
})
