/**
 * A failed or slow admission read never fails or stalls a put: it becomes an
 * unknown verdict the device can judge from the pool.
 */
import { describe, it } from "vitest"

describe("admissionOrUnavailable", () => {
    it.todo("returns the source's verdict unchanged when the read succeeds in time")
    it.todo("returns unknown with admission-unavailable when the source throws")
    it.todo("returns unknown with admission-unavailable when the source misses the deadline")
    it.todo("clears its deadline timer once the read settles")
})
