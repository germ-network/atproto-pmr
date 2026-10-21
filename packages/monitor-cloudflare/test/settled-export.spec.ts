import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { settleDue, type IngestDeps, type SettledDeclaration } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import { FIREHOSE_COVERAGE_KEY } from "../src/firehose-coverage-store"
import type { MonitorIngest } from "../src/ingest-object"
import * as exported from "../src/index"

const testEnv = env as unknown as MonitorEnv
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

let n = 0
const freshStub = (): DurableObjectStub<MonitorIngest> => {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`settled-${n}`))
}

describe("monitor-cloudflare deployment seams", () => {
    it("MonitorIngest.onSettled is overridable and receives every settle", async () => {
        const did = "did:plc:settled-export"
        const car = new Uint8Array([7, 8, 9])
        const raised = await runInDurableObject(freshStub(), async (obj: MonitorIngest) => {
            const seen: Array<{ did: string; settled: SettledDeclaration | null }> = []
            ;(obj as unknown as { onSettled: MonitorIngest["onSettled"] }).onSettled = async (
                d: string,
                settled: SettledDeclaration | null
            ) => void seen.push({ did: d, settled })
            await obj.intake({ did, rev: "3m1" }, "c1")
            const deps = (obj as unknown as { deps(): IngestDeps }).deps()
            await settleDue({
                ...deps,
                fetchRecord: async () => ({ car, source: PDS, signingKey: SIGNING_KEY }),
                verify: async () => ({
                    kind: "verified",
                    key: SIGNING_KEY,
                    rev: "3m1",
                    cid: "bafyreistub",
                }),
            })
            return seen
        })
        expect(raised).toHaveLength(1)
        expect(raised[0]!.did).toBe(did)
        expect(raised[0]!.settled).toMatchObject({ rev: "3m1", cid: "bafyreistub" })
        expect([...raised[0]!.settled!.car]).toEqual([7, 8, 9])
    })

    it("kvFirehoseCoverage is exported and reads what the ingest object writes", async () => {
        await testEnv.records.put(
            FIREHOSE_COVERAGE_KEY,
            '{"continuousSinceMs":1,"coveredThroughMs":2,"lagging":["did:plc:a"]}'
        )
        expect(await exported.kvFirehoseCoverage(testEnv)()).toEqual({
            continuousSinceMs: 1,
            coveredThroughMs: 2,
            lagging: ["did:plc:a"],
        })
    })
})
