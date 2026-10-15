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

    /** Set what `ownBlocks(did)` answers: blocks, null (not served), or "throw". */
    async setOwnBlocks(did: string, answer: unknown): Promise<void> {
        await this.ctx.storage.put(`ownBlocks:${did}`, answer)
    }

    async ownBlocks(did: string): Promise<unknown> {
        const answer = await this.ctx.storage.get(`ownBlocks:${did}`)
        if (answer === "throw") throw new Error("monitor down")
        return answer === undefined ? null : answer
    }

    /** Set what `ownGraph(did)` answers: a graph, null (not served), or "throw". */
    async setOwnGraph(did: string, answer: unknown): Promise<void> {
        await this.ctx.storage.put(`ownGraph:${did}`, answer)
    }

    async ownGraph(did: string): Promise<unknown> {
        const answer = await this.ctx.storage.get(`ownGraph:${did}`)
        if (answer === "throw") throw new Error("monitor down")
        return answer === undefined ? null : answer
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
