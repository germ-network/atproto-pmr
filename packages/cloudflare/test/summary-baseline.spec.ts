/**
 * Served summary states are private to the owner's registration and stored
 * one entry per token.
 */
import { describe, it } from "vitest"

describe("summary index storage", () => {
    it.todo("an index stored under a token reads back unchanged")
    it.todo("a token never stored reads null")
    it.todo("storing past SUMMARY_TOKENS_KEPT drops the oldest token only")
    it.todo("two registrations' tokens are independent")
})
