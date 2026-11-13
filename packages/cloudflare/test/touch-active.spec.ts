/**
 * `PMRObject.touchActive`: first authenticated owner interaction per UTC day,
 * monotonic, never creating or resurrecting a registration.
 */
import { describe, it } from "vitest"

describe("touchActive", () => {
    it.todo("first touch on a later UTC day writes nowSeconds")
    it.todo("a second touch the same UTC day leaves lastActive unchanged")
    it.todo("a same-day or earlier nowSeconds never decreases lastActive")
    it.todo("23:59:59 → 00:00:00 UTC writes")
    it.todo("no registration → no write, and none is created")
    it.todo("after destroy() → no registration is resurrected")
    it.todo("registration without a did → no write")
    it.todo("anchorKey given and different → no write")
    it.todo("non-finite stored lastActive → no write")
})
