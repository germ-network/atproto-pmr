/** Test-only entry so wrangler can find the Durable Object classes. */
import { DurableObject } from "cloudflare:workers"

export { PMRObject } from "../src/pmr-object"

/** Stands in for a monitor's ingest object: records the calls it receives. */
export class MonitorIngestStub extends DurableObject {
    async register(did: string): Promise<void> {
        await this.record("register", did)
    }

    async unregister(did: string): Promise<void> {
        await this.record("unregister", did)
    }

    async requestRefresh(did: string, requestedAtMs: number): Promise<void> {
        await this.ctx.storage.put("refreshes", [
            ...(await this.refreshes()),
            { did, requestedAtMs },
        ])
    }

    async refreshes(): Promise<{ did: string; requestedAtMs: number }[]> {
        return (
            (await this.ctx.storage.get<{ did: string; requestedAtMs: number }[]>("refreshes")) ?? []
        )
    }

    /** Whether the DID's directory row existed when each call arrived, keyed `call:did`. */
    async rowSeen(): Promise<Record<string, boolean>> {
        return (await this.ctx.storage.get<Record<string, boolean>>("rowSeen")) ?? {}
    }

    async calls(): Promise<string[]> {
        return (await this.ctx.storage.get<string[]>("calls")) ?? []
    }

    private async record(call: string, did: string): Promise<void> {
        const calls = await this.calls()
        await this.ctx.storage.put("calls", [...calls, `${call}:${did}`])
        const seen = await this.rowSeen()
        const row = await (this.env as { pmrDirectory: KVNamespace }).pmrDirectory.get(did)
        await this.ctx.storage.put("rowSeen", { ...seen, [`${call}:${did}`]: row !== null })
    }
}

export default {
    async fetch(): Promise<Response> {
        return new Response("test worker", { status: 200 })
    },
}
