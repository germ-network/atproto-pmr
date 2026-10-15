/**
 * The pool listing tells the device why the relay pooled each sender, so the
 * device judges with the relay's reason instead of recomputing it.
 */
import { describe, it } from "vitest"

describe("GET /pmr/v1/pool verdicts", () => {
    it.todo("an entry with a verdict carries v (no | unknown) and r (reason codes, in order)")
    it.todo("an entry pooled without a verdict carries neither v nor r")
    it.todo("keeps did and n unchanged")
})
