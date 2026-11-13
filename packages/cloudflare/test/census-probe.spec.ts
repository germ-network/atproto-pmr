/**
 * `KVDirectory.listRouteCandidates` / `probeRegistration`: the read-only
 * census seam. Every probe must leave the registration exactly as it found it.
 */
import { describe, it } from "vitest"

describe("listRouteCandidates", () => {
    it.todo("returns route DIDs only, never tomb: keys")
    it.todo("round-trips the cursor across more than one page, null past the last")
})

describe("probeRegistration", () => {
    it.todo("live registration → its stored lastActive")
    it.todo("leaves the record byte-identical, sets no alarm and notifies no monitor")
    it.todo("route present but no record (create crash window) → null")
    it.todo("route to a destroyed locator → null")
    it.todo("DID listed but route deleted before the probe → null")
    it.todo("malformed locator → null")
    it.todo("record did mismatched or missing → null")
    it.todo("unparsable stored anchorKey → null")
    it.todo("routed but tombstoned (deregister crash window) → null")
    it.todo("different-key replace between list and probe → reads only the new incarnation")
    it.todo("logs nothing naming the DID on any branch, including a throwing load")
})
