/**
 * The relay applies a can-message verdict as an admission: blocks become relay
 * blocks, refusals and undecided verdicts keep their reasons for the pool, and
 * a policy the relay does not yet honour admits nobody.
 */
import { describe, it } from "vitest"

describe("admissionOf", () => {
    it.todo("maps a no naming blocked to blocked")
    it.todo("maps any other no to no with its why")
    it.todo("maps unknown to unknown with its why")
    it.todo("maps null to unknown recipient-not-held")
    it.todo("maps a yes via open alone to unknown policy-not-enabled")
    it.todo("maps a yes via bsky-follows (with or without open) to yes")
})
