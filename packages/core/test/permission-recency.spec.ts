import { describe, expect, it } from "vitest"
import { permissionRecencyAtMs } from "../src/permission-recency.js"

describe("proposed permission-recency aggregate", () => {
    it("uses the latest timestamp when all three inputs are available", () => {
        expect(
            permissionRecencyAtMs({
                messagingKeyFirstSeenAtMs: 1_000,
                aFollowedBAtMs: 3_000,
                bFollowedAAtMs: 2_000,
            })
        ).toBe(3_000)
    })

    it("does not claim a maximum when any required input is unavailable", () => {
        expect(
            permissionRecencyAtMs({
                messagingKeyFirstSeenAtMs: 1_000,
                aFollowedBAtMs: null,
                bFollowedAAtMs: 2_000,
            })
        ).toBeNull()
    })

    it("rejects invalid values instead of exposing a fabricated order", () => {
        expect(
            permissionRecencyAtMs({
                messagingKeyFirstSeenAtMs: 1_000,
                aFollowedBAtMs: -1,
                bFollowedAAtMs: 2_000,
            })
        ).toBeNull()
    })
})
