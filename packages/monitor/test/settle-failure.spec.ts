import { describe, expect, it, vi } from "vitest"
import {
    settle,
    settleDue,
    settleRetryBackoffMs,
    PENDING_FAILURE_MESSAGE_MAX,
    SETTLE_RETRY_CAP_MS,
    type SettleFailureEvent,
    type IngestDeps,
} from "../src/ingest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import type { MonitorIndex, PendingFailure } from "../src/storage"

const DID = "did:plc:alice"
const NOW = 1_000_000
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const DAY_MS = 24 * 3_600_000

interface Row {
    rev: string
    attempts: number
    notBeforeMs: number
    quiet: boolean
    failure?: PendingFailure
}

/** Only what settle and settleDue touch; the real index is a Durable Object. */
function harness(overrides: Partial<IngestDeps> = {}, held: string[] = []) {
    const pending = new Map<string, Row>()
    const revs = new Map<string, string>(held.map((did) => [did, "3m1"]))
    const deferrals: Array<{ did: string; notBeforeMs: number; failure: PendingFailure }> = []
    const attempted: string[] = []
    const cleared: string[] = []
    const index = {
        duePending: async (nowMs: number) =>
            [...pending.entries()]
                .filter(([, p]) => p.notBeforeMs <= nowMs)
                .map(([did, p]) => ({ did, ...p })),
        deferPending: async (did: string, notBeforeMs: number, failure: PendingFailure) => {
            deferrals.push({ did, notBeforeMs, failure })
            const p = pending.get(did)
            if (p === undefined) return null
            pending.set(did, { ...p, attempts: p.attempts + 1, notBeforeMs, failure })
            return p.attempts + 1
        },
        owedGenOf: async () => null,
        revOf: async (did: string) => revs.get(did) ?? null,
        holderStateOf: async () => null,
        heldDeclarationOf: async () => null,
        recordSeenKey: async () => {},
        isWatched: async () => true,
        isDeleted: async () => false,
        clearPending: async (did: string) => {
            cleared.push(did)
            pending.delete(did)
        },
        markAttempted: async (did: string) => void attempted.push(did),
        complete: async (did: string, rev: string) => {
            revs.set(did, rev)
            pending.delete(did)
        },
        completeQuietly: async (did: string, rev: string) => {
            revs.set(did, rev)
            pending.delete(did)
        },
        completeDeletion: async (did: string) => void pending.delete(did),
    } as unknown as MonitorIndex
    const deps: IngestDeps = {
        index,
        snapshot: {
            getRecord: async () => null,
            putRecord: async () => {},
            deleteRecord: async () => {},
        } as unknown as IngestDeps["snapshot"],
        fetchRecord: async () => ({
            car: new Uint8Array([1]),
            source: "https://pds.example",
            signingKey: SIGNING_KEY,
        }),
        verify: async (_did, record) => ({
            kind: "verified",
            key: record.signingKey ?? SIGNING_KEY,
            rev: "3m2",
            cid: "bafyreicid",
        }),
        interest: { inInterest: async () => true, interestEpoch: async () => 0 },
        nowMs: () => NOW,
        ...overrides,
    }
    const owe = (did: string, attempts = 0, quiet = false) =>
        void pending.set(did, { rev: "3m2", attempts, notBeforeMs: 0, quiet })
    return { deps, pending, revs, deferrals, attempted, cleared, owe }
}

const unverifiable: IngestDeps["verify"] = async () => ({ kind: "unverifiable" })
const throwing: IngestDeps["fetchRecord"] = async () => {
    throw new Error("PDS unreachable")
}

describe("settle retry backoff", () => {
    it("doubles from one second per attempt and stops at SETTLE_RETRY_CAP_MS", () => {
        expect([0, 1, 2, 3, 10].map((n) => settleRetryBackoffMs(n))).toEqual([
            1000, 2000, 4000, 8000, 1_024_000,
        ])
        expect(settleRetryBackoffMs(21)).toBe(2 ** 21 * 1000)
        expect(settleRetryBackoffMs(22)).toBe(SETTLE_RETRY_CAP_MS)
        expect(settleRetryBackoffMs(10, 60_000)).toBe(60_000)
    })

    it("stays finite and at the cap for very large attempts (30, 10_000)", () => {
        for (const attempts of [30, 10_000]) {
            expect(settleRetryBackoffMs(attempts)).toBe(SETTLE_RETRY_CAP_MS)
            expect(settleRetryBackoffMs(attempts, 3_600_000)).toBe(3_600_000)
        }
    })

    it("settleDue caps each DID's retry at what retryCapMs answers for it, and at SETTLE_RETRY_CAP_MS without retryCapMs", async () => {
        const held = "did:plc:held"
        const capped = harness(
            { fetchRecord: throwing, retryCapMs: async (did) => (did === held ? 3_600_000 : DAY_MS) },
        )
        capped.owe(held, 30)
        capped.owe(DID, 30)
        await settleDue(capped.deps)
        expect(capped.pending.get(held)?.notBeforeMs).toBe(NOW + 3_600_000)
        expect(capped.pending.get(DID)?.notBeforeMs).toBe(NOW + DAY_MS)

        const uncapped = harness({ fetchRecord: throwing })
        uncapped.owe(DID, 30)
        await settleDue(uncapped.deps)
        expect(uncapped.pending.get(DID)?.notBeforeMs).toBe(NOW + SETTLE_RETRY_CAP_MS)
    })

    it("settleDue defers a throwing settle by settleRetryBackoffMs of the attempts so far", async () => {
        const h = harness({ fetchRecord: throwing })
        h.owe(DID, 3)
        await settleDue(h.deps)
        expect(h.pending.get(DID)?.notBeforeMs).toBe(NOW + settleRetryBackoffMs(3))
        expect(h.pending.get(DID)?.attempts).toBe(4)
    })

    it("a never-held unverifiable DID waits the larger of unverifiableRetryMs and the backoff", async () => {
        const fresh = harness({ verify: unverifiable })
        fresh.owe(DID, 0)
        await settleDue(fresh.deps)
        expect(fresh.pending.get(DID)?.notBeforeMs).toBe(NOW + 3_600_000)

        const stuck = harness({ verify: unverifiable })
        stuck.owe(DID, 15)
        await settleDue(stuck.deps)
        expect(stuck.pending.get(DID)?.notBeforeMs).toBe(NOW + settleRetryBackoffMs(15))

        const floor = harness({ verify: unverifiable, unverifiableRetryMs: 90_000_000 })
        floor.owe(DID, 15)
        await settleDue(floor.deps)
        expect(floor.pending.get(DID)?.notBeforeMs).toBe(NOW + 90_000_000)

        const capped = harness({ verify: unverifiable, retryCapMs: async () => 3_600_000 })
        capped.owe(DID, 30)
        await settleDue(capped.deps)
        expect(capped.pending.get(DID)?.notBeforeMs).toBe(NOW + 3_600_000)
    })

    it("a held unverifiable DID is not deferred and reports no failure", async () => {
        const events: unknown[] = []
        const h = harness({ verify: unverifiable, onSettleFailure: (e) => void events.push(e) }, [DID])
        h.owe(DID, 2)
        expect(await settle(h.deps, DID, { attempts: 2 })).toBe("unverifiable")
        expect(h.deferrals).toEqual([])
        expect(h.cleared).toEqual([DID])
        expect(h.attempted).toEqual([DID])
        expect(events).toEqual([])
    })
})

function spy() {
    const events: SettleFailureEvent[] = []
    return { events, onSettleFailure: (e: SettleFailureEvent) => void events.push(e) }
}

describe("settle failure reporting", () => {
    it("a throwing settle reports one event with the DID, attempts, error name and message, and not-before", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({
            onSettleFailure,
            fetchRecord: async () => {
                throw new TypeError("fetch failed")
            },
        })
        h.owe(DID, 2)
        await settleDue(h.deps)
        expect(events).toEqual([
            {
                did: DID,
                attempts: 3,
                failure: { kind: "threw", errorName: "TypeError", message: "fetch failed", atMs: NOW },
                notBeforeMs: NOW + settleRetryBackoffMs(2),
            },
        ])
    })

    it("a never-held unverifiable DID reports one event of kind unverifiable with the verifier's reason", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({
            onSettleFailure,
            verify: async () => ({ kind: "unverifiable", reason: "signature mismatch" }),
        })
        h.owe(DID, 0)
        await settleDue(h.deps)
        expect(events).toEqual([
            {
                did: DID,
                attempts: 1,
                failure: { kind: "unverifiable", reason: "signature mismatch", atMs: NOW },
                notBeforeMs: NOW + 3_600_000,
            },
        ])
    })

    it("the failure handed to deferPending is the one reported, with the attempts deferPending answered", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({ onSettleFailure, fetchRecord: throwing })
        h.owe(DID, 4)
        const store = h.deps.index.deferPending.bind(h.deps.index)
        h.deps.index.deferPending = async (...args) => (await store(...args), 99)
        await settleDue(h.deps)
        expect(h.deferrals).toHaveLength(1)
        expect(events[0]?.failure).toEqual(h.deferrals[0]?.failure)
        expect(events[0]?.notBeforeMs).toBe(h.deferrals[0]?.notBeforeMs)
        expect(events[0]?.attempts).toBe(99)
    })

    it("no event when deferPending finds no pending row (settle outside the retry queue)", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({ onSettleFailure, verify: unverifiable })
        expect(await settle(h.deps, DID)).toBe("unverifiable")
        expect(h.deferrals).toHaveLength(1)
        expect(events).toEqual([])
    })

    it("a long error message or unverifiable reason is truncated once, identically in the stored failure and the event", async () => {
        const long = "x".repeat(PENDING_FAILURE_MESSAGE_MAX * 4)
        const threw = spy()
        const a = harness({
            onSettleFailure: threw.onSettleFailure,
            fetchRecord: async () => {
                throw new Error(long)
            },
        })
        a.owe(DID)
        await settleDue(a.deps)
        const unv = spy()
        const b = harness({
            onSettleFailure: unv.onSettleFailure,
            verify: async () => ({ kind: "unverifiable", reason: long }),
        })
        b.owe(DID)
        await settleDue(b.deps)
        for (const [h, got] of [
            [a, threw],
            [b, unv],
        ] as const) {
            const stored = h.deferrals[0]?.failure
            const text = stored?.kind === "threw" ? stored.message : stored?.reason
            expect(text).toHaveLength(PENDING_FAILURE_MESSAGE_MAX)
            expect(got.events[0]?.failure).toEqual(stored)
        }
    })

    it("a confirmed deletion (RecordNotFoundError) reports nothing", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({
            onSettleFailure,
            fetchRecord: async () => {
                throw new RecordNotFoundError("RecordNotFound", false)
            },
        })
        h.owe(DID)
        await settleDue(h.deps)
        expect(h.deferrals).toEqual([])
        expect(events).toEqual([])
    })

    it("a verified absence, a regression and a DID that left interest report nothing", async () => {
        const { events, onSettleFailure } = spy()
        const absent = harness({
            onSettleFailure,
            verify: async () => ({ kind: "verified-absent", key: SIGNING_KEY, rev: "3m2" }),
        })
        absent.owe(DID)
        await settleDue(absent.deps)

        const regressed = harness({ onSettleFailure }, [DID])
        regressed.revs.set(DID, "3m9")
        regressed.owe(DID)
        await settleDue(regressed.deps)

        let calls = 0
        const left = harness({
            onSettleFailure,
            interest: { inInterest: async () => true, interestEpoch: async () => calls++ },
        })
        left.owe(DID)
        await settleDue(left.deps)

        expect([absent, regressed, left].flatMap((h) => h.deferrals)).toEqual([])
        expect(events).toEqual([])
    })

    it("a stored settle reports nothing", async () => {
        const { events, onSettleFailure } = spy()
        const h = harness({ onSettleFailure })
        h.owe(DID)
        expect(await settleDue(h.deps)).toBe(1)
        expect(events).toEqual([])
    })

    it("a throwing onSettleFailure does not stop the drain or lose the deferral", async () => {
        const h = harness({
            fetchRecord: throwing,
            onSettleFailure: () => {
                throw new Error("log sink down")
            },
        })
        h.owe("did:plc:one")
        h.owe("did:plc:two")
        await expect(settleDue(h.deps)).resolves.toBe(0)
        expect(h.pending.get("did:plc:one")?.attempts).toBe(1)
        expect(h.pending.get("did:plc:two")?.attempts).toBe(1)
    })

    describe("a failure to record a deferral costs only its own DID", () => {
        const [A, B, C] = ["did:plc:a", "did:plc:b", "did:plc:c"]
        const throwingForA: IngestDeps["fetchRecord"] = async (did) => {
            if (did === A) throw new Error("PDS unreachable")
            return {
                car: new Uint8Array([1]),
                source: "https://pds.example",
                signingKey: SIGNING_KEY,
            }
        }

        async function drain(h: ReturnType<typeof harness>) {
            h.owe(A)
            h.owe(B)
            h.owe(C)
            const logged = vi.spyOn(console, "error").mockImplementation(() => {})
            try {
                await expect(settleDue(h.deps)).resolves.toBe(2)
                return logged.mock.calls
            } finally {
                logged.mockRestore()
            }
        }

        it("a throwing deferPending for A still settles B and C, and is logged once with A", async () => {
            const h = harness({ fetchRecord: throwingForA })
            h.deps.index.deferPending = async () => {
                throw new Error("SQLITE_BUSY")
            }
            const calls = await drain(h)
            expect([...h.pending.keys()]).toEqual([A])
            expect(h.revs.get(B)).toBe("3m2")
            expect(h.revs.get(C)).toBe("3m2")
            expect(calls).toEqual([["monitor: settle defer failed", { did: A, err: expect.any(Error) }]])
        })

        it("a throwing retryCapMs for A still settles B and C, and is logged once with A", async () => {
            const h = harness({
                fetchRecord: throwingForA,
                retryCapMs: async () => {
                    throw new Error("SQLITE_BUSY")
                },
            })
            const calls = await drain(h)
            expect([...h.pending.keys()]).toEqual([A])
            expect(calls).toEqual([["monitor: settle defer failed", { did: A, err: expect.any(Error) }]])
        })
    })
})
