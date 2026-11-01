/**
 * Only the monitor's verified view retires a registration, only after it has
 * confirmed that registration's own anchor, and nothing revives one.
 */
import { describe, expect, it } from "vitest"
import { encodeCose, type CoseValue } from "../src/cose/cbor"
import { encodeOkpEd25519Key } from "../src/cose/key"
import { applyVerifiedAnchorObservation } from "../src/registration-lifecycle"

const DID = "did:plc:lifecycle"
const LOC = "loc:active"
const keyOf = (fill: number) => encodeOkpEd25519Key({ x: new Uint8Array(32).fill(fill) })

function world(opts: { active?: string | null; confirmed?: boolean } = {}) {
    const retired: Array<[string, string]> = []
    let confirmed = opts.confirmed ?? true
    return {
        retired,
        confirmed: () => confirmed,
        directory: {
            retire: async (did: string, expected: string) => {
                retired.push([did, expected])
                return opts.active === undefined ? LOC : opts.active
            },
        },
        store: {
            isMonitorConfirmed: async () => confirmed,
            markMonitorConfirmed: async () => {
                confirmed = true
            },
        },
    }
}

const apply = (w: ReturnType<typeof world>, observation: Parameters<typeof applyVerifiedAnchorObservation>[5], active = keyOf(1)) =>
    applyVerifiedAnchorObservation(w.directory, w.store, DID, LOC, active, observation)

describe("applyVerifiedAnchorObservation", () => {
    it("a verified different anchor retires the active registration", async () => {
        const w = world()
        expect(await apply(w, { state: "present", anchorKey: keyOf(2) })).toBe("retired")
        expect(w.retired).toEqual([[DID, LOC]])
    })

    it("a verified record-level absence retires the active registration", async () => {
        const w = world()
        expect(await apply(w, { state: "absent" })).toBe("retired")
        expect(w.retired).toHaveLength(1)
    })

    it("the same verified anchor changes nothing, even re-encoded", async () => {
        const w = world()
        // The same key with an extra field: different bytes, same public key.
        const reencoded = encodeCose(
            new Map<number, CoseValue>([
                [1, 1],
                [-1, 6],
                [-2, new Uint8Array(32).fill(1)],
                [2, new Uint8Array([9])],
            ])
        )
        expect(reencoded).not.toEqual(keyOf(1))
        expect(await apply(w, { state: "present", anchorKey: reencoded })).toBe("unchanged")
        expect(w.retired).toEqual([])
    })

    it("unknown changes nothing", async () => {
        const w = world()
        expect(await apply(w, { state: "unknown" })).toBe("unchanged")
        expect(w.retired).toEqual([])
    })

    it("reports unchanged when the directory retired nothing", async () => {
        const w = world({ active: null })
        expect(await apply(w, { state: "absent" })).toBe("unchanged")
    })

    it("an unparseable active key never counts as the same anchor", async () => {
        const w = world()
        expect(await apply(w, { state: "present", anchorKey: keyOf(1) }, new Uint8Array([1, 2, 3]))).toBe("retired")
    })

    it("before the monitor has confirmed the registration's anchor, nothing retires it", async () => {
        const w = world({ confirmed: false })
        expect(await apply(w, { state: "present", anchorKey: keyOf(2) })).toBe("unchanged")
        expect(await apply(w, { state: "absent" })).toBe("unchanged")
        expect(w.retired).toEqual([])
        expect(w.confirmed()).toBe(false)
    })

    it("a verified present of its own anchor confirms it, after which an absence retires it", async () => {
        const w = world({ confirmed: false })
        await apply(w, { state: "present", anchorKey: keyOf(1) })
        expect(w.confirmed()).toBe(true)
        expect(await apply(w, { state: "absent" })).toBe("retired")
    })
})
