import { describe, it } from "vitest"

describe("summaryCoverageAtMs (S7)", () => {
    it.todo("is the earlier of the firehose and PLC covered-through instants")
    it.todo("is null when either watermark is missing, the firehose one is null, or the PLC run ended")
})

describe("summary w and l (S7)", () => {
    it.todo("encodes the spec's updated summary vector byte for byte (11 keys)")
    it.todo("carries w and l on every 200, including an unchanged token")
    it.todo("reads coverage before the index and any CAR")
    it.todo("l lists only this summary's truncated contacts that are lagging, sorted, empty when none")
    it.todo("never lists a lagging DID outside the owner's contacts")
    it.todo("an old decoder ignores w and l")
})
