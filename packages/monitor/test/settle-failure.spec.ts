import { describe, expect, it } from "vitest"
import {
    settle,
    settleDue,
    settleRetryBackoffMs,
    SETTLE_RETRY_CAP_MS,
    type IngestDeps,
} from "../src/ingest"
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
        revOf: async (did: string) => revs.get(did) ?? null,
        holderStateOf: async () => null,
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
    return { deps, pending, deferrals, attempted, cleared, owe }
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

describe("settle failure reporting", () => {
    it.todo("a throwing settle reports one event with the DID, attempts, error name and message, and not-before")
    it.todo("a never-held unverifiable DID reports one event of kind unverifiable with the verifier's reason")
    it.todo("the failure handed to deferPending is the one reported, with the attempts deferPending answered")
    it.todo("no event when deferPending finds no pending row (settle outside the retry queue)")
    it.todo("a long error message or unverifiable reason is truncated once, identically in the stored failure and the event")
    it.todo("a confirmed deletion (RecordNotFoundError) reports nothing")
    it.todo("a verified absence, a regression and a DID that left interest report nothing")
    it.todo("a stored settle reports nothing")
    it.todo("a throwing onSettleFailure does not stop the drain or lose the deferral")
})
