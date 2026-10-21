/**
 * The relay's read of the bound monitor's verified anchor: a down or unbound
 * monitor answers `unknown`, which retires nothing.
 */
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { PMREnv } from "../src/env"
import { monitorVerifiedAnchor } from "../src/monitor-verified-anchor"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"

const testEnv = env as unknown as PMREnv<PMRObject>

let didCounter = 0
const freshDID = () => `did:plc:verified-anchor-test-${(didCounter += 1)}`

function ingest() {
    const ns = testEnv.MONITOR_INGEST!
    return ns.get(
        ns.idFromName(testEnv.MONITOR_INGEST_NAME!)
    ) as unknown as DurableObjectStub<MonitorIngestStub>
}

describe("monitorVerifiedAnchor", () => {
    it("returns the bound monitor's observation", async () => {
        const did = freshDID()
        await ingest().setVerifiedAnchor(did, { state: "absent" })
        expect(await monitorVerifiedAnchor(testEnv)(did)).toEqual({ state: "absent" })
    })

    it("answers unknown when no monitor is bound", async () => {
        for (const unbound of [
            { ...testEnv, MONITOR_INGEST: undefined },
            { ...testEnv, MONITOR_INGEST_NAME: undefined },
        ]) {
            expect(await monitorVerifiedAnchor(unbound)(freshDID())).toEqual({ state: "unknown" })
        }
    })

    it("answers unknown, with a warning, when the monitor call throws", async () => {
        const did = freshDID()
        await ingest().setVerifiedAnchor(did, "throw")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            expect(await monitorVerifiedAnchor(testEnv)(did)).toEqual({ state: "unknown" })
            expect(warn).toHaveBeenCalledTimes(1)
        } finally {
            warn.mockRestore()
        }
    })
})
