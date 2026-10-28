/**
 * A commit's rev must be a TID, so every rev the monitor stores has a bounded
 * length.
 */
import { describe, it } from "vitest"

describe("commit rev shape", () => {
    it.todo("a commit whose rev is not a TID is commit-malformed")
    it.todo("a commit with a TID rev decodes as before")
})
