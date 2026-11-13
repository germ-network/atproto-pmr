/**
 * `onIntakeStored`: fires once per real stored intake, after the body write,
 * and can never change an outcome or delay delivery.
 */
import { describe, it } from "vitest"

describe("onIntakeStored fires once", () => {
    it.todo("request-held")
    it.todo("admission-queued")
    it.todo("admission-held")
    it.todo("mailbox-appended")
    it.todo("pair-evidence held, appended and queued")
    it.todo("grant appended")
    it.todo("sender-hold: at release, never at admit")
    it.todo("with acceptedAtS equal to the put's nowSeconds")
})

describe("onIntakeStored does not fire", () => {
    it.todo("synthetic persistBody:false")
    it.todo("duplicate / replay")
    it.todo("dropped")
    it.todo("refused, tooLarge, noRecipient, unverifiable")
    it.todo("grant with a bad tag, a closed address or an unknown address")
    it.todo("again when a held entry is promoted (moved refs)")
    it.todo("when putBody rejects")
})

describe("onIntakeStored failures", () => {
    it.todo("a throwing or rejecting hook leaves outcome, body and live/push delivery unchanged, console silent")
    it.todo("a never-settling hook does not delay live/push delivery")
})
