/**
 * A device read of a lapsed declaration reaches the bound monitor as a
 * refresh request, and never fails the read when the monitor is absent or down.
 */
import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import type { PMREnv } from "../src/env"
import { monitorRecheck } from "../src/monitor-recheck"
import type { PMRObject } from "../src/pmr-object"
import type { MonitorIngestStub } from "./worker"

const testEnv = env as unknown as PMREnv<PMRObject>

let didCounter = 0
const freshDID = () => `did:plc:recheck-test-${(didCounter += 1)}`

function ingest() {
    const ns = testEnv.MONITOR_INGEST!
    return ns.get(
        ns.idFromName(testEnv.MONITOR_INGEST_NAME!)
    ) as unknown as DurableObjectStub<MonitorIngestStub>
}

describe("monitorRecheck", () => {
    it("forwards the DID and the request time to the ingest object's requestRefresh", async () => {
        const did = freshDID()
        await monitorRecheck(testEnv, () => 1_234_567)(did)
        expect((await ingest().refreshes()).filter((r) => r.did === did)).toEqual([
            { did, requestedAtMs: 1_234_567 },
        ])
    })

    it("does nothing when no monitor is bound", async () => {
        const did = freshDID()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            for (const unbound of [
                { ...testEnv, MONITOR_INGEST: undefined },
                { ...testEnv, MONITOR_INGEST_NAME: undefined },
            ]) {
                await monitorRecheck(unbound)(did)
            }
            expect((await ingest().refreshes()).filter((r) => r.did === did)).toEqual([])
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
        }
    })

    it("resolves, with a warning, when the monitor call throws", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const failing = {
            ...testEnv,
            MONITOR_INGEST: {
                idFromName: () => ({}),
                get: () => ({
                    requestRefresh: () => Promise.reject(new Error("monitor down")),
                }),
            } as unknown as DurableObjectNamespace,
        }
        try {
            await expect(monitorRecheck(failing)(freshDID())).resolves.toBeUndefined()
            expect(warn).toHaveBeenCalledTimes(1)
        } finally {
            warn.mockRestore()
        }
    })
})
