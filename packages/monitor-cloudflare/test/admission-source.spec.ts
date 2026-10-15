/**
 * Admission is read straight from D1 and the records KV, judging the hosted
 * recipient's view of the sender, without touching the monitor's ingest object.
 */
import { describe, it } from "vitest"

describe("d1AdmissionSource", () => {
    it.todo("judges (sender, recipient) with the recipient's policies and the recipient's facts about the sender; swapping them changes the verdict")
    it.todo("a recipient who blocks the sender reads blocked")
    it.todo("a recipient whose graph is not served reads unknown")
    it.todo("reads no PDS and does not touch the ingest object, even for a stale snapshot")
})
