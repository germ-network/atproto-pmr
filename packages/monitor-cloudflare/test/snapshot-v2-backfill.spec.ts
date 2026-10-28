/**
 * A one-shot backfill re-settles every held declaration and secondary from
 * its PDS, so every entry reaches the v2 layout.
 */
import { describe, it } from "vitest"

describe("snapshot v2 backfill", () => {
    it.todo("owes a fetch for every held declaration and every held secondary")
    it.todo("runs once: a second wake after completion owes nothing")
    it.todo("a re-settle at an unchanged rev rewrites the entry as v2 without a push")
    it.todo("runs without MONITOR_HOSTNAME configured")
    it.todo("an owed secondary keeps its existing backoff")
    it.todo("an own-block proof of a registered owner is re-stored as v2")
    it.todo("a DID that is gone or not held is not owed")
    it.todo("a secondary of a DID outside interest is not owed")
})
