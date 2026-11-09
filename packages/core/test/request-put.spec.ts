/**
 * A put held in a request mailbox stores its body and wakes nothing; one the
 * shared quota drops stores nothing; one the sender's depth refuses answers
 * 429. The put's outcome vocabulary does not change.
 */
import { describe, it } from "vitest"

describe("ingestAuthenticatedPut into a request mailbox", () => {
    it.todo("stores the body of a held put and calls neither deliverLive nor deliverPush")
    it.todo("writes no body for a dropped put and answers accepted")
    it.todo("answers refused with the store's retryAfter when the request mailbox is full")
    it.todo("holds through appendToRequest on the no-admission path when the store has no mailbox")
    it.todo("treats held and dropped from receive and from appendPair alike")
    it.todo("delivers request entries a yes moved before the admitted put, with one push")
})

describe("handlePairPut into a request mailbox", () => {
    it.todo("answers 202 for a held put and for a dropped one")
    it.todo("answers 429 with Retry-After when the sender's request mailbox is full")
})
