/** `sk:<did>` in `records`: the shape the relay's cache reads. */
import { describe, it } from "vitest"

describe("kvSigningKeyCache (S3)", () => {
    it.todo("put then get round-trips {key, fetchedAtMs}, including key: null")
    it.todo("stores under sk:<did> with an expirationTtl no shorter than the relay's max-stale bound")
    it.todo("delete removes the entry; get → null")
    // After the rebase: a top-level `satisfies` against core's SigningKeyCache, enforced by typecheck.
})
