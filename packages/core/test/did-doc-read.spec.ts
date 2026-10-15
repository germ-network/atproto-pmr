/**
 * The DID-document route gives every caller the same answer, from held
 * state only: a did:plc log a device verifies itself, a did:web document as
 * a hint, or a miss.
 */
import { describe, it } from "vitest"

describe("handleDidDocRead", () => {
    it.todo("a served did:plc DID with a held log returns its entries, asOfMs and coverage")
    it.todo("a served did:web DID returns its cached document")
    it.todo("a DID not served reads not-watched")
    it.todo("a served DID with nothing held reads not-held")
    it.todo("a malformed path is 400")
    it.todo("responses are 200, no-store, with no validators")
})

describe("did-doc read codec", () => {
    it.todo("each variant round-trips")
    it.todo("each operation travels as its JSON text, byte for byte")
    it.todo("unknown keys are ignored; a missing required field throws")
})
