/**
 * The store keeps each pooled sender's latest verdict exactly as long as it
 * keeps the sender's pool entries.
 */
import { describe, it } from "vitest"

describe("PMRObject pool verdicts", () => {
    it.todo("a pooled put records its verdict, listed by poolSenders")
    it.todo("a later pooled put replaces the recorded verdict")
    it.todo("a discarded or duplicate put does not change the recorded verdict")
    it.todo("provision, discard and block drop the recorded verdict with the pool entries")
})
