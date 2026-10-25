import { describe, expect, it, vi } from "vitest"
import { monitorPermissionRecencyReader } from "../src/monitor-permission-recency"

const request = (method: (...args: unknown[]) => Promise<unknown>) => {
    const stub = { permissionRecencyForRecipients: method }
    const namespace = {
        idFromName: (name: string) => name,
        get: () => stub,
    }
    return namespace as never
}

describe("monitorPermissionRecencyReader", () => {
    it("forwards one batched recipient read to the monitor", async () => {
        const method = vi.fn(async () => new Map([ ["did:plc:r", 123] ]))
        const read = monitorPermissionRecencyReader({
            MONITOR_INGEST: request(method),
            MONITOR_INGEST_NAME: "singleton",
        })
        const recipients = ["did:plc:r"]
        await expect(read("did:plc:s", recipients)).resolves.toEqual(new Map([["did:plc:r", 123]]))
        expect(method).toHaveBeenCalledOnce()
        expect(method).toHaveBeenCalledWith("did:plc:s", recipients)
    })

    it("returns unknown values when no monitor is configured", async () => {
        const read = monitorPermissionRecencyReader({})
        await expect(read("did:plc:s", ["did:plc:r", "did:plc:q"])).resolves.toEqual(
            new Map([
                ["did:plc:r", null],
                ["did:plc:q", null],
            ])
        )
    })

    it("degrades a failed monitor read to unknown recency", async () => {
        const read = monitorPermissionRecencyReader({
            MONITOR_INGEST: request(async () => {
                throw new Error("monitor unavailable")
            }),
            MONITOR_INGEST_NAME: "singleton",
        })
        await expect(read("did:plc:s", ["did:plc:r"])).resolves.toEqual(new Map([["did:plc:r", null]]))
    })
})
