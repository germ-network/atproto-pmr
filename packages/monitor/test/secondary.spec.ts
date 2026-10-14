/**
 * Secondary records settle quietly: verified before anything is stored,
 * never written over a newer rev, and never a digest-window entry, a push or
 * a `revs` change.
 */
import { describe, it } from "vitest"

describe("settleSecondary", () => {
    it.todo("settles without window, onChange or revs change")
    it.todo("older rev never overwrites a newer stored secondary")
    it.todo("verified absence at a current rev deletes only the secondary")
    it.todo("repo-level not-found on a secondary does not delete it directly")
    it.todo("unverifiable secondary keeps the previous entry")
    it.todo("a repo-level deletion disposes the profile")
    it.todo("a null not-found reason (did:plc tombstone) counts as repo-level")
    it.todo("a secondary older than the indexed rev is not written to KV")
    it.todo("a secondary whose DID left interest after its put has that KV entry deleted")
})
