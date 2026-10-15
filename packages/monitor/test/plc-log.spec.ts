/**
 * The monitor's kept did:plc logs are fetched whole from the directory,
 * stored only once they verify, and retried at a bounded rate.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PlcLog } from "@germ-network/atproto-pmr-core"
import { PLC_LOG_RETRY_MS, drainPlcLogs, type PlcLogIndex } from "../src/plc-log"
import legacy from "../../core/test/fixtures/plc-log-legacy-genesis.json"
import modern from "../../core/test/fixtures/plc-log-modern.json"

afterEach(() => vi.restoreAllMocks())

const NOW = 1_800_000_000_000

function world(bodies: Record<string, unknown | Error>, owed: { did: string; attemptedAtMs: number }[]) {
    const stored: PlcLog[] = []
    const attempted: { did: string; atMs: number }[] = []
    const asked: { before: number; limit: number }[] = []
    const fetched: string[] = []
    const index = {
        owedPlcLogs: async (before: number, limit: number) => {
            asked.push({ before, limit })
            return owed
                .filter((o) => o.attemptedAtMs < before)
                .slice(0, limit)
                .map((o) => o.did)
        },
        putPlcLog: async (log: PlcLog) => void stored.push(log),
        markPlcLogAttempted: async (did: string, atMs: number) => void attempted.push({ did, atMs }),
    } as unknown as PlcLogIndex
    const deps = {
        index,
        fetchAuditLog: async (did: string) => {
            fetched.push(did)
            const body = bodies[did]
            if (body instanceof Error) throw body
            return body
        },
        nowMs: () => NOW,
    }
    return { deps, stored, attempted, asked, fetched }
}

describe("drainPlcLogs", () => {
    it("stores a fetched log that verifies, asOfMs at the fetch", async () => {
        const w = world({ [modern.did]: modern.audit, [legacy.did]: legacy.audit }, [
            { did: modern.did, attemptedAtMs: 0 },
            { did: legacy.did, attemptedAtMs: 0 },
        ])
        expect(await drainPlcLogs(w.deps, 10)).toBe(2)
        expect(w.stored.map((l) => l.did)).toEqual([modern.did, legacy.did])
        expect(w.stored.every((l) => l.asOfMs === NOW)).toBe(true)
        expect(w.stored[0]!.entries).toHaveLength(modern.audit.length)
        expect(w.attempted).toEqual([])
    })

    it("a log that does not parse or verify is a failed attempt, not stored", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const tampered = modern.audit.map((e, i) =>
            i === 1 ? { ...e, operation: { ...e.operation, alsoKnownAs: ["at://evil.test"] } } : e
        )
        const w = world(
            { [modern.did]: tampered, [legacy.did]: { message: "not found" } },
            [
                { did: modern.did, attemptedAtMs: 0 },
                { did: legacy.did, attemptedAtMs: 0 },
            ]
        )
        expect(await drainPlcLogs(w.deps, 10)).toBe(0)
        expect(w.stored).toEqual([])
        expect(w.attempted).toEqual([
            { did: modern.did, atMs: NOW },
            { did: legacy.did, atMs: NOW },
        ])
    })

    it("a fetch that throws is a failed attempt", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const w = world({ [modern.did]: new Error("directory down"), [legacy.did]: legacy.audit }, [
            { did: modern.did, attemptedAtMs: 0 },
            { did: legacy.did, attemptedAtMs: 0 },
        ])
        expect(await drainPlcLogs(w.deps, 10)).toBe(1)
        expect(w.attempted).toEqual([{ did: modern.did, atMs: NOW }])
        expect(w.stored.map((l) => l.did)).toEqual([legacy.did])
    })

    it("drains at most limit owed DIDs, skipping those attempted within PLC_LOG_RETRY_MS", async () => {
        const w = world({ [modern.did]: modern.audit, [legacy.did]: legacy.audit }, [
            { did: modern.did, attemptedAtMs: NOW - PLC_LOG_RETRY_MS + 1 },
            { did: legacy.did, attemptedAtMs: NOW - PLC_LOG_RETRY_MS - 1 },
        ])
        expect(await drainPlcLogs(w.deps, 1)).toBe(1)
        expect(w.asked).toEqual([{ before: NOW - PLC_LOG_RETRY_MS, limit: 1 }])
        expect(w.fetched).toEqual([legacy.did])
    })
})
