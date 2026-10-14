/**
 * The index against the real Durable Object storage engine.
 *
 * The properties worth pinning here are the ones the design leans on and
 * an in-memory fake cannot prove: that intake and the cursor move together
 * across an eviction, that a replayed event costs no fetch, and that a
 * failed fetch stays owed — because the stream will not redeliver it.
 */
import {
    env,
    evictDurableObject,
    runDurableObjectAlarm,
    runInDurableObject,
} from "cloudflare:test"
import { gcm } from "@noble/ciphers/aes.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    binaryToBase64URL,
    RecordNotFoundError,
    STORED_DID_DOCUMENT_MAX_AGE_MS,
    type CachedDidDocument,
    type DidDocument,
} from "@germ-network/atproto-pmr-core"
import {
    decodeDigestWindows,
    intake,
    mightHaveChanged,
    sealDueWindows,
    intakePlcEvent,
    settleDue,
    sweepBackfill,
    FETCH_AS_OF_SKEW_MS,
    type FetchedRecord,
    type IngestDeps,
    type PlcExportEvent,
} from "@germ-network/atproto-pmr-monitor"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import { kvMonitorRegistrationStore } from "../src/registration-store"
import { DIGEST_MARKER_KEY, kvDeclarationSnapshots, kvSnapshotStore } from "../src/snapshot-store"
import { canonicalDidDocumentJson, kvDidDocuments, kvPlcCoverage } from "../src/did-document-store"
import { kvSigningKeyCache } from "../src/signing-key-store"
import { needsRearm } from "../src/ingest-object"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

const STUB_VERIFIED = { cid: "bafyreistub", verifiedWith: SIGNING_KEY }

let n = 0
function freshStub(): DurableObjectStub<MonitorIngest> {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`ingest-${n}`))
}

/** Reach in to drive the ingest object with a stubbed authoritative fetch. */
/** Enter the object with its own type, mirroring inPMR upstream. */
function inMonitorObj<R>(
    stub: DurableObjectStub<MonitorIngest>,
    fn: (obj: MonitorIngest) => R | Promise<R>
): Promise<R> {
    return runInDurableObject(stub, (instance) => fn(instance as MonitorIngest))
}

/**
 * Builds its own `IngestDeps` by hand and does NOT set `onChange` /
 * `onRegression` — both are optional on `IngestDeps` and `settle()` calls
 * them via `?.()`, so omitting them means they silently never fire through
 * this helper. Fine for tests that only care about the index/snapshot; the
 * wrong tool for anything asserting on own-DID push side effects — use
 * `withFetchThroughRealOnChange` (in the "own-DID push" describe block)
 * for those instead, which routes through the object's real `deps()`.
 */
/** A fetch stub's CAR is a placeholder, so its signed rev rides along for `stubVerify`. */
type StubFetched = FetchedRecord & { rev: string }

const stubVerify: IngestDeps["verify"] = async (_did, record) =>
    record.signingKey === null
        ? { kind: "unverifiable" }
        : {
              kind: "verified",
              key: record.signingKey,
              rev: (record as StubFetched).rev,
              cid: "bafyreistub",
          }

function withFetch(
    stub: DurableObjectStub<MonitorIngest>,
    fetchRecord: (did: string) => Promise<StubFetched>
) {
    return runInDurableObject(stub, async (obj: MonitorIngest) => {
        ;(obj as unknown as { fetchRecord: typeof fetchRecord }).fetchRecord = fetchRecord
        return settleDue({
            index: obj,
            snapshot: kvSnapshotStore(testEnv),
            fetchRecord,
            verify: stubVerify,
            nowMs: () => Date.now(),
        })
    })
}

describe("the index", () => {
    it("advances the cursor with intake, read back on a separate entry", async () => {
        // Proves the cursor lives in storage, not an in-memory field --
        // but NOT that it survives an eviction: `runInDurableObject` reuses
        // the same live instance across calls to one stub unless something
        // actually evicts it in between. See "the alarm chain resumes..."
        // below for the real eviction test.
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "1786695916763191")
        )
        const cursor = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.readCursor()
        )
        expect(cursor).toBe("1786695916763191")
    })

    it("the alarm chain resumes the Jetstream cursor across an eviction", async () => {
        // The design's actual resilience claim (ingest-object.ts's class
        // doc comment): an eviction is indistinguishable from any other
        // gap because the alarm reconnects from the STORED cursor. That
        // needs a genuine eviction to prove -- evictDurableObject() tears
        // down the in-memory instance (including `socket`) while keeping
        // storage, which the platform's own eviction does too. A test that
        // only reuses the same live instance across calls (the test above)
        // cannot tell "storage is durable" from "the reconnect logic
        // actually reads it back", since neither one is exercised without
        // a real instance teardown in between.
        const stub = freshStub()
        const cursor = "1786695916763191"
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, cursor)
            // An alarm survives eviction (it's platform-scheduled state,
            // not in-memory) -- arm one so runDurableObjectAlarm below has
            // something to fire on the fresh post-eviction instance.
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })

        await evictDurableObject(stub)

        // alarm() also runs sweepBackfill() and settleDue() in the same
        // tick, both of which call fetch too -- so every request is
        // recorded rather than just the last one, and the Jetstream
        // request is found by its URL rather than assumed to be first.
        const requestedUrls: string[] = []
        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) => {
            requestedUrls.push(typeof url === "string" ? url : url.toString())
            // A real 200 with no `webSocket`, not an invalid status --
            // connect() then throws its own "did not upgrade" error on
            // the missing socket, same as any other fetch call here that
            // has nowhere real to reach in this harness. The URL each
            // call was given, captured above, is the property under test.
            return Promise.resolve(new Response(null, { status: 200 }))
        }) as typeof fetch

        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // Expected: every fetch in this tick fails the same way.
        } finally {
            globalThis.fetch = original
        }

        const jetstreamRequest = requestedUrls.find((u) => u.includes("jetstream"))
        expect(jetstreamRequest).toBeDefined()
        expect(new URL(jetstreamRequest!).searchParams.get("cursor")).toBe(cursor)
    })

    it("owes a fetch for an unseen rev", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            return obj.duePending(Date.now(), 10)
        })
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("drops a replayed event without owing a fetch, but still advances", async () => {
        // Resume rewinds to a segment boundary, so most of what arrives
        // after a reconnect is already applied. It must cost an index read,
        // not a PDS round trip — while still accounting for the event.
        const stub = freshStub()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), STUB_VERIFIED)
            const outcome = await obj.intake({ did: DID, rev: "3m1" }, "200")
            return {
                outcome: outcome.outcome,
                owed: (await obj.duePending(Date.now(), 10)).length,
                cursor: await obj.readCursor(),
            }
        })
        expect(result).toEqual({ outcome: "duplicate", owed: 0, cursor: "200" })
    })

    it("clears the obligation on completion", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.complete(DID, "3m1", Date.now(), STUB_VERIFIED)
            return obj.duePending(Date.now(), 10)
        })
        expect(owed).toEqual([])
    })

    it("completeDeletion marks isDeleted, clears the obligation, and reaches the digest window", async () => {
        const stub = freshStub()
        const observedAtMs = Date.now()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.completeDeletion(DID, observedAtMs, true)
            return {
                isDeleted: await obj.isDeleted(DID),
                owed: (await obj.duePending(Date.now(), 10)).length,
                members: await obj.windowMembers(
                    Math.floor(observedAtMs / 600_000) * 600_000
                ),
            }
        })
        expect(result.isDeleted).toBe(true)
        expect(result.owed).toBe(0)
        expect(result.members).toContain(DID)
    })

    it("completeDeletion leaves the rev index untouched -- the regression floor survives", async () => {
        const stub = freshStub()
        const untouched = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), STUB_VERIFIED)
            await obj.completeDeletion(DID, Date.now(), true)
            return obj.revOf(DID)
        })
        expect(untouched).toBe("3m1")
    })

    it("a later complete() (resurrection) clears a prior completeDeletion mark", async () => {
        const stub = freshStub()
        const isDeleted = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.completeDeletion(DID, Date.now(), true)
            await obj.complete(DID, "3m9", Date.now(), STUB_VERIFIED)
            return obj.isDeleted(DID)
        })
        expect(isDeleted).toBe(false)
    })

    it("isDeleted is false for a DID never marked deleted", async () => {
        const stub = freshStub()
        const isDeleted = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.isDeleted(DID)
        )
        expect(isDeleted).toBe(false)
    })

    it("a REVERSIBLE completeDeletion (permanent=false) still reaches the digest and clears pending, but does NOT mark isDeleted", async () => {
        // The wedge this pins: RepoTakendown/RepoSuspended/RepoDeactivated
        // are reversible account-lifecycle states. Marking isDeleted for
        // one of these would permanently suppress every later
        // identity/account/sync event for the DID (see intake's reverify
        // guard) -- with no jetstream signal this object decodes that
        // could ever un-suppress it. A DID reinstated after suspension,
        // without ever republishing its declaration, would then stay
        // unserved and unwatched forever.
        const stub = freshStub()
        const observedAtMs = Date.now()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.completeDeletion(DID, observedAtMs, false)
            return {
                isDeleted: await obj.isDeleted(DID),
                owed: (await obj.duePending(Date.now(), 10)).length,
                members: await obj.windowMembers(
                    Math.floor(observedAtMs / 600_000) * 600_000
                ),
            }
        })
        expect(result.isDeleted).toBe(false)
        expect(result.owed).toBe(0)
        expect(result.members).toContain(DID)
    })
})

describe("settling what is owed", () => {
    it("stores the record and indexes the rev", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "100")
        )
        const car = new Uint8Array([1, 2, 3])
        const settled = await withFetch(stub, async () => ({
            rev: "3m1",
            car,
            source: PDS,
            signingKey: SIGNING_KEY,
        }))
        expect(settled).toBe(1)

        const stored = await kvSnapshotStore(testEnv).getRecord(DID)
        expect(stored?.rev).toBe("3m1")
        expect([...(stored?.car ?? [])]).toEqual([1, 2, 3])
        expect(stored?.source).toBe(PDS)
        expect(stored?.signingKey).toBe(SIGNING_KEY)
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.revOf(DID))).toBe("3m1")
    })

    it("keeps a failed fetch owed, with backoff", async () => {
        // Jetstream will not redeliver, so the pending row is the only
        // thing between a PDS outage and a silently dropped DID.
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.intake({ did: DID, rev: "3m1" }, "100")
        )
        const settled = await withFetch(stub, async () => {
            throw new Error("PDS unreachable")
        })
        expect(settled).toBe(0)

        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now() + 10 ** 9, 10)
        )
        expect(owed[0]?.attempts).toBe(1)
        expect(owed[0]?.notBeforeMs).toBeGreaterThan(Date.now())
    })

    it("holds a backed-off fetch until its time comes", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.deferPending(DID, Date.now() + 10 ** 6)
        })
        const dueNow = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(dueNow).toEqual([])
    })
})

describe("the way in", () => {
    it("start() arms the alarm, so a deployed object is not inert", async () => {
        // There was no entry point at all: connect armed the alarm and
        // only the alarm called connect. A fresh object never started.
        const stub = freshStub()
        const before = await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())
        expect(before).toBeNull()

        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            // connect() reaches the network; arming is the part under test.
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const after = await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())
        expect(after).not.toBeNull()
    })

    it("needsRearm treats an overdue alarm the same as an absent one", () => {
        // Real incident: a due alarm that was never dispatched left
        // getAlarm() permanently non-null, and the old "only if null"
        // guard treated that identically to a healthy pending alarm --
        // start()/connect() kept succeeding every poke while nothing was
        // ever sealed or fetched again, because nothing ever replaced it.
        // Tested directly against real numbers, not through the DO's own
        // storage: the local dev runtime clears an overdue alarm back to
        // null almost instantly, unlike production, where this one stayed
        // non-null for over three hours -- so the real storage can't
        // reproduce the state this guards against.
        const now = Date.now()
        expect(needsRearm(null, now)).toBe(true)
        expect(needsRearm(now - 60_000, now)).toBe(true)
        expect(needsRearm(now, now)).toBe(true)
        expect(needsRearm(now + 60_000, now)).toBe(false)
    })

    it(
        "connect() aborts a stalled Jetstream upgrade rather than hanging forever",
        async () => {
            // Real regression: an upgrade fetch that accepts the connection
            // and never completes the handshake used to hang connect()
            // forever -- and because this runs inside alarm(), which is
            // single-threaded with every other call into the object, the
            // WHOLE object wedged: digestPage() and every other RPC queued
            // behind it with no way out. Proven by a mock fetch that never
            // resolves on its own; connect() must still settle (by
            // rejecting), not hang. Asserts the outcome, not elapsed time.
            const stub = freshStub()
            const original = globalThis.fetch
            globalThis.fetch = ((_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("The operation was aborted.", "AbortError"))
                    })
                })) as typeof fetch
            try {
                await expect(
                    runInDurableObject(stub, (obj: MonitorIngest) => obj.connect())
                ).rejects.toThrow(/abort/i)
            } finally {
                globalThis.fetch = original
            }
        },
        10_000
    )

    it("owes a re-read on demand, past the dedupe check", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), STUB_VERIFIED)
            // intake would call this a duplicate; a rotation still needs it.
            await obj.owe(DID, "3m1")
            return obj.duePending(Date.now(), 10)
        })
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("clearPending discharges without indexing", async () => {
        const stub = freshStub()
        const after = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.intake({ did: DID, rev: "3m1" }, "100")
            await obj.clearPending(DID)
            return { owed: await obj.duePending(Date.now(), 10), rev: await obj.revOf(DID) }
        })
        expect(after.owed).toEqual([])
        expect(after.rev).toBeNull()
    })
})

describe("digest windows", () => {
    it("records a completed fetch in the window it was OBSERVED in", async () => {
        // Observation time, not event time: a sealed filter cannot be
        // amended, and the retry path settles arbitrarily late.
        const stub = freshStub()
        const observedAtMs = 12 * 600_000 + 5_000
        const members = await inMonitorObj(stub, async (obj) => {
            await obj.complete(DID, "3m1", observedAtMs, STUB_VERIFIED)
            // Identified by START INSTANT, so the width can be retuned
            // without old and new windows colliding on one key.
            return obj.windowMembers(12 * 600_000)
        })
        expect(members).toEqual([DID])
    })

    it("seals closed windows on the alarm, leaving the open one alone", async () => {
        const stub = freshStub()
        const now = Date.now()
        const currentWindow = Math.floor(now / 600_000) * 600_000
        const sealed = await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:old", "3m1", currentWindow - 2 * 600_000, STUB_VERIFIED)
            await obj.complete("did:plc:now", "3m2", now, STUB_VERIFIED)
            // As if sealing had already progressed to just before the old
            // window on a prior tick — a fresh install starts coverage
            // "now", not retroactively, so this test needs a marker to
            // exercise catching up on a real backlog.
            await kvSnapshotStore(testEnv).putDigestMarker({
                sealedThrough: currentWindow - 3 * 600_000,
                oldest: currentWindow - 3 * 600_000,
            })
            return sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                retentionMs: 7 * 24 * 60 * 60 * 1000,
                nowMs: () => now,
            })
        })
        // Both the old window AND the empty one between it and current seal
        // — every window in range gets a physical entry now, not only the
        // ones with members.
        expect(sealed).toEqual([currentWindow - 2 * 600_000, currentWindow - 600_000])

        const bytes = await kvSnapshotStore(testEnv).getSealedWindow(String(currentWindow - 2 * 600_000))
        const [w] = decodeDigestWindows(bytes!)
        expect(mightHaveChanged(w, "did:plc:old")).toBe(true)
        expect(mightHaveChanged(w, "did:plc:now")).toBe(false)

        // The current window is still accumulating.
        const stillOpen = await inMonitorObj(stub, (obj) => obj.windowMembers(currentWindow))
        expect(stillOpen).toEqual(["did:plc:now"])
    })

    it("keys a window by its start instant, divisible by the width", async () => {
        // Identity is the start instant, not an index. An index is
        // ambiguous the moment the width is tuned — index 5 means minutes
        // 50-60 at ten minutes and 25-30 at five — so every key would mean
        // two things. An instant means one thing under any width.
        //
        // It does NOT make retuning free: an instant divisible by both
        // widths is a shared key, so changing the width requires clearing
        // digest state (see the note on `DIGEST_WINDOW_MS`). What it buys
        // is that the collision surface is aligned boundaries rather than
        // every key, and any survivor is self-describing about its width.
        const stub = freshStub()
        const t = 12 * 600_000 + 5_000
        const members = await inMonitorObj(stub, async (obj) => {
            await obj.complete(DID, "3m1", t, STUB_VERIFIED)
            return obj.windowMembers(12 * 600_000)
        })
        expect(members).toEqual([DID])
        expect((12 * 600_000) % 600_000).toBe(0)
    })

    it("tracks the digest marker, the boundary between empty and unpublished", async () => {
        // The marker lives in KV now, not the object's own storage — a
        // request handler reads it directly and never touches the object
        // at all.
        const stub = freshStub()
        const now = Date.now()
        // KV, unlike a fresh DO id, is shared across this file's tests —
        // an earlier test may have already written the singleton marker
        // key, so start from a known-clean state rather than assume one.
        await testEnv.records.delete(DIGEST_MARKER_KEY)
        const before = await kvSnapshotStore(testEnv).getDigestMarker()
        expect(before).toBeNull()
        await inMonitorObj(stub, (obj) =>
            sealDueWindows({
                index: obj,
                snapshot: kvSnapshotStore(testEnv),
                widthMs: 600_000,
                retentionMs: 7 * 24 * 60 * 60 * 1000,
                nowMs: () => now,
            })
        )
        const marker = await kvSnapshotStore(testEnv).getDigestMarker()
        expect(marker?.sealedThrough).toBe(Math.floor(now / 600_000) * 600_000 - 600_000)
    })
})

describe("backfill", () => {
    it("starts unstarted, and persists progress across a separate entry into the object", async () => {
        const stub = freshStub()
        const before = await inMonitorObj(stub, (obj) => obj.readBackfillProgress())
        expect(before).toEqual({ done: false, cursor: null })

        await inMonitorObj(stub, (obj) =>
            obj.setBackfillProgress({ done: false, cursor: "page-2" })
        )
        // A separate entry: state came from storage, not memory.
        expect(await inMonitorObj(stub, (obj) => obj.readBackfillProgress())).toEqual({
            done: false,
            cursor: "page-2",
        })
    })

    it("discovers a DID via the real index, and owes it for the next settle pass", async () => {
        const stub = freshStub()
        const swept = await inMonitorObj(stub, (obj) =>
            sweepBackfill({
                index: obj,
                listRepos: async () => ({ dids: [DID], nextCursor: null }),
            })
        )
        expect(swept).toEqual({ discovered: 1, done: true })

        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(owed.map((p) => p.did)).toEqual([DID])
    })

    it("does not re-discover a DID the live tail already indexed", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.complete(DID, "3m1", Date.now(), STUB_VERIFIED)
        )
        const swept = await inMonitorObj(stub, (obj) =>
            sweepBackfill({
                index: obj,
                listRepos: async () => ({ dids: [DID], nextCursor: null }),
            })
        )
        expect(swept.discovered).toBe(0)
        const owed = await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.duePending(Date.now(), 10)
        )
        expect(owed).toEqual([])
    })
})

describe("the snapshot store", () => {
    it("keeps records without a TTL — an unchanged record stays served", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putRecord("did:plc:ttl", {
            rev: "3m1",
            car: new Uint8Array([9]),
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: "bafyreistub",
        })
        const back = await store.getRecord("did:plc:ttl")
        expect(back).toMatchObject({
            rev: "3m1",
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
        })
    })

    it("returns null for a DID it has never seen", async () => {
        expect(await kvSnapshotStore(testEnv).getRecord("did:plc:nobody")).toBeNull()
    })

    it("deleteRecord removes a served record; a subsequent getRecord is null", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putRecord("did:plc:gone", {
            rev: "3m1",
            car: new Uint8Array([9]),
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: "bafyreistub",
        })
        await store.deleteRecord("did:plc:gone")
        expect(await store.getRecord("did:plc:gone")).toBeNull()
    })

    it("deleteRecord on a DID that was never stored is a no-op, not an error", async () => {
        await expect(
            kvSnapshotStore(testEnv).deleteRecord("did:plc:never-stored")
        ).resolves.toBeUndefined()
    })

    it("round-trips a sealed window", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putSealedWindow("w1", new Uint8Array([4, 5]))
        expect([...((await store.getSealedWindow("w1")) ?? [])]).toEqual([4, 5])
        expect(await store.getSealedWindow("w-absent")).toBeNull()
    })

    it("round-trips the digest marker, absent until the first write", async () => {
        // See the note on DIGEST_MARKER_KEY: KV is shared across this
        // file's tests, so this starts from a known-clean state.
        await testEnv.records.delete(DIGEST_MARKER_KEY)
        const store = kvSnapshotStore(testEnv)
        expect(await store.getDigestMarker()).toBeNull()
        await store.putDigestMarker({ sealedThrough: 42, oldest: 7 })
        expect(await store.getDigestMarker()).toEqual({ sealedThrough: 42, oldest: 7 })
    })
})

describe("own-DID push", () => {
    // Not a real, curve-paired keypair — matches `push.spec.ts`'s upstream
    // precedent: nothing here cross-verifies a signature, only that the
    // right bytes reach the right place.
    const PRIVATE_KEY_B64 = binaryToBase64URL(crypto.getRandomValues(new Uint8Array(32)))
    const PUBLIC_KEY_B64 = binaryToBase64URL(
        (() => {
            const bytes = crypto.getRandomValues(new Uint8Array(65))
            bytes[0] = 0x04
            return bytes
        })()
    )
    const HOST_NAME = "monitor.example"

    async function withPushEnabled(
        stub: DurableObjectStub<MonitorIngest>,
        extra: Record<string, string> = {}
    ): Promise<void> {
        await runInDurableObject(stub, (obj: MonitorIngest) => {
            const held = obj as unknown as { env: MonitorEnv }
            held.env = {
                ...held.env,
                HOST_NAME,
                VAPID_PUBLIC_KEY: PUBLIC_KEY_B64,
                VAPID_PRIVATE_KEY: PRIVATE_KEY_B64,
                VAPID_SUBJECT: "mailto:ops@relay.example",
                PUSH_MAX_SEALED_BYTES: "2880",
                PUSH_TTL_SECONDS: "86400",
                ...extra,
            }
        })
    }

    async function putRegistration(
        did: string,
        overrides: Partial<{ endpoint: string; contentKey: Uint8Array; keyId: number }> = {}
    ): Promise<void> {
        await kvMonitorRegistrationStore(testEnv)!.put({
            did,
            anchorKey: new Uint8Array([1]),
            pushSubscription: {
                endpoint: overrides.endpoint ?? "https://push.example/sub/1",
                contentKey: overrides.contentKey ?? new Uint8Array(32).fill(1),
                keyId: overrides.keyId ?? 7,
            },
            registeredAt: 0,
        })
    }

    /**
     * Reaches past `notifyRegistration`'s `ctx.waitUntil` wrapper to call
     * the real work directly and await it — the same reasoning
     * `deliverDeclarationPush`'s own doc comment gives: asserting on the
     * result of something handed to `waitUntil` races the runtime's own
     * background scheduling, which is not guaranteed to have run by the
     * time `runInDurableObject`'s outer promise resolves.
     */
    function callDeliverDeclarationPush(
        stub: DurableObjectStub<MonitorIngest>,
        did: string
    ): Promise<void> {
        return runInDurableObject(stub, (obj: MonitorIngest) =>
            (obj as unknown as { deliverDeclarationPush(did: string): Promise<void> })
                .deliverDeclarationPush(did)
        )
    }

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it("POSTs a sealed {t:\"d\"} push to the registered subscription", async () => {
        const did = "did:plc:push-advance"
        const stub = freshStub()
        await withPushEnabled(stub)
        await putRegistration(did)

        let seenUrl: string | undefined
        let seenAuth: string | null = null
        let seenTopic: string | null = null
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            seenUrl = typeof input === "string" ? input : input.toString()
            const headers = new Headers(init?.headers)
            seenAuth = headers.get("Authorization")
            seenTopic = headers.get("Topic")
            return new Response(null, { status: 201 })
        })

        await callDeliverDeclarationPush(stub, did)

        expect(seenUrl).toBe("https://push.example/sub/1")
        expect(seenAuth).toMatch(/^vapid t=.+, k=.+$/)
        // A constant Topic per declaration-change push, so a burst from one
        // subscriber (a hostile PDS churning revs) collapses at the push
        // service instead of eating into the subscription's daily quota.
        expect(seenTopic).toBe("d")
    })

    it("a discard response (404/410) deletes the registration", async () => {
        const did = "did:plc:push-discard"
        const stub = freshStub()
        await withPushEnabled(stub)
        await putRegistration(did)
        vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }))

        await callDeliverDeclarationPush(stub, did)

        expect(await kvMonitorRegistrationStore(testEnv)!.load(did)).toBeNull()
    })

    it("a single 401 does NOT delete the registration, but logs the failure", async () => {
        // A `"failed"` outcome is the base-wide-misconfiguration case (a
        // rotated VAPID key that no longer pairs) — the one outcome that
        // must not be silent, matching `push.spec.ts`'s equivalent test on
        // the PMR side. `pushDeclarationChange` cannot throw one, so this
        // is the one that only a live check on its returned outcome, not
        // a bare try/catch, can catch.
        const did = "did:plc:push-failed"
        const stub = freshStub()
        await withPushEnabled(stub)
        await putRegistration(did)
        vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        await callDeliverDeclarationPush(stub, did)

        expect(await kvMonitorRegistrationStore(testEnv)!.load(did)).not.toBeNull()
        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(errorSpy.mock.calls[0].join(" ")).toContain("401")
    })

    it("the sealed body is bound to this deployment's HOST_NAME as AAD", async () => {
        // Mirrors `packages/cloudflare/test/push.spec.ts`'s AAD test: the
        // one thing that would otherwise pass every other test here even
        // with `aad:` dropped from `push-sender.ts`.
        const did = "did:plc:push-aad"
        const stub = freshStub()
        await withPushEnabled(stub)
        const contentKey = new Uint8Array(32).fill(3)
        await putRegistration(did, { contentKey })

        let seenBody: Uint8Array | undefined
        vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
            seenBody = init?.body instanceof Uint8Array ? init.body : undefined
            return new Response(null, { status: 201 })
        })

        await callDeliverDeclarationPush(stub, did)

        const nonce = seenBody!.slice(1, 13)
        const ciphertextAndTag = seenBody!.slice(13)

        expect(() => gcm(contentKey, nonce).decrypt(ciphertextAndTag)).toThrow()
        expect(() =>
            gcm(contentKey, nonce, new TextEncoder().encode("wrong.host")).decrypt(
                ciphertextAndTag
            )
        ).toThrow()

        const recovered = gcm(
            contentKey,
            nonce,
            new TextEncoder().encode(HOST_NAME)
        ).decrypt(ciphertextAndTag)
        expect(recovered.byteLength).toBeGreaterThan(0)
    })

    it("no registration for the DID: no push attempted", async () => {
        const did = "did:plc:push-unregistered"
        const stub = freshStub()
        await withPushEnabled(stub)
        const fetchSpy = vi.fn()
        vi.stubGlobal("fetch", fetchSpy)

        await callDeliverDeclarationPush(stub, did)

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("no push configuration bound: a silent no-op", async () => {
        const did = "did:plc:push-unconfigured"
        const stub = freshStub()
        // withPushEnabled is deliberately NOT called.
        await putRegistration(did)
        const fetchSpy = vi.fn()
        vi.stubGlobal("fetch", fetchSpy)

        await callDeliverDeclarationPush(stub, did)

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("is a no-op when VAPID is only PARTIALLY configured", async () => {
        const did = "did:plc:push-partial-config"
        const stub = freshStub()
        await putRegistration(did)
        // Only the public key — no private key, subject, etc. Partial
        // configuration is treated the same as none, not a degraded push.
        await withPushEnabled(stub, {})
        await runInDurableObject(stub, (obj: MonitorIngest) => {
            const held = obj as unknown as { env: MonitorEnv }
            held.env = { ...held.env, VAPID_PRIVATE_KEY: undefined as unknown as string }
        })
        const fetchSpy = vi.fn()
        vi.stubGlobal("fetch", fetchSpy)

        await callDeliverDeclarationPush(stub, did)

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("is a no-op when PUSH_MAX_SEALED_BYTES is non-numeric — a misconfiguration, not a degraded push", async () => {
        const did = "did:plc:push-nan-config"
        const stub = freshStub()
        await putRegistration(did)
        await withPushEnabled(stub, { PUSH_MAX_SEALED_BYTES: "not-a-number" })
        const fetchSpy = vi.fn()
        vi.stubGlobal("fetch", fetchSpy)

        await callDeliverDeclarationPush(stub, did)

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("a push that throws does not propagate, and is logged", async () => {
        const did = "did:plc:push-throws"
        const stub = freshStub()
        await withPushEnabled(stub)
        await putRegistration(did)
        vi.stubGlobal("fetch", async () => {
            throw new Error("network down")
        })
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(callDeliverDeclarationPush(stub, did)).resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalled()
    })

    it("a malformed VAPID_PRIVATE_KEY throws before any request, and is still caught and logged", async () => {
        // monitorWebPushSender decodes VAPID_PRIVATE_KEY eagerly, before
        // send() is ever called — a corrupted secret throws right there,
        // outside a guard scoped to only the send call. Same
        // base-wide-misconfiguration class as the test above, just
        // triggered a step earlier — and the same class of bug this
        // session already found and fixed once on the PMR side
        // (atproto-pmr#15, `pmr-object.ts`'s `deliverPush`).
        const did = "did:plc:push-bad-key"
        const stub = freshStub()
        await withPushEnabled(stub, { VAPID_PRIVATE_KEY: "not valid base64url!!!" })
        await putRegistration(did)
        const fetchSpy = vi.fn()
        vi.stubGlobal("fetch", fetchSpy)
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(callDeliverDeclarationPush(stub, did)).resolves.toBeUndefined()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(errorSpy).toHaveBeenCalled()
    })

    describe("wiring: settle() reaches deliverDeclarationPush without waiting for it", () => {
        // These prove `onChange`/`onRegression` actually kick off the real
        // work (not just that the real work is correct in isolation, which
        // the tests above cover) — by replacing `deliverDeclarationPush`
        // with a spy *before* `settle()` runs. The call happens
        // synchronously (the promise is constructed and handed to
        // `ctx.waitUntil` in the same tick), so awaiting `settleDue`'s own
        // return is enough to observe it — no reliance on `waitUntil`
        // actually finishing its background work.
        /**
         * `withFetch` (this file's other helper) builds its own `IngestDeps`
         * by hand and never sets `onChange`/`onRegression`, so `settle()`'s
         * `deps.onChange?.(...)` optional-call silently no-ops through that
         * path — fine for the tests that only care about the index/snapshot,
         * wrong for these, which exist to prove `onChange`/`onRegression`
         * are wired to something real. This reaches the object's own
         * `deps()` (what `alarm()` itself uses) instead, so the real
         * `onChange`/`onRegression` methods are the ones `settle()` calls.
         */
        function withFetchThroughRealOnChange(
            stub: DurableObjectStub<MonitorIngest>,
            fetchRecord: (did: string) => Promise<StubFetched>
        ) {
            return runInDurableObject(stub, async (obj: MonitorIngest) => {
                const realDeps = (obj as unknown as { deps(): IngestDeps }).deps()
                return settleDue({ ...realDeps, fetchRecord, verify: stubVerify })
            })
        }

        function spyOnDeliver(
            stub: DurableObjectStub<MonitorIngest>
        ): Promise<ReturnType<typeof vi.fn>> {
            return runInDurableObject(stub, (obj: MonitorIngest) => {
                const held = obj as unknown as {
                    deliverDeclarationPush(did: string): Promise<void>
                }
                const spy = vi.fn(async () => {})
                held.deliverDeclarationPush = spy
                return spy
            })
        }

        it("an advancing rev calls deliverDeclarationPush with the changed DID", async () => {
            const did = "did:plc:push-wiring-advance"
            const stub = freshStub()
            const spy = await spyOnDeliver(stub)
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.intake({ did, rev: "3m1" }, "c1")
            )

            await withFetchThroughRealOnChange(stub, async () => ({
                rev: "3m1",
                car: new Uint8Array([1]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }))

            expect(spy).toHaveBeenCalledWith(did)
        })

        it("a regression also calls deliverDeclarationPush", async () => {
            const did = "did:plc:push-wiring-regression"
            const stub = freshStub()
            const spy = await spyOnDeliver(stub)
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.complete(did, "3m9", Date.now(), STUB_VERIFIED)
            )
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.intake({ did, rev: "3m1" }, "c1")
            )

            await withFetchThroughRealOnChange(stub, async () => ({
                rev: "3m1",
                car: new Uint8Array([1]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }))

            expect(spy).toHaveBeenCalledWith(did)
        })

        it("an unchanged rev with no key rotation does NOT call deliverDeclarationPush", async () => {
            const did = "did:plc:push-wiring-unchanged"
            const stub = freshStub()
            const spy = await spyOnDeliver(stub)
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.complete(did, "3m1", Date.now(), STUB_VERIFIED)
            )
            // Intake a DIFFERENT claimed rev than what's already indexed,
            // so this genuinely owes a fetch rather than deduping to
            // "duplicate" (same rev in, same rev already indexed) — which
            // would never even reach `settle()`, making this test pass
            // for the wrong reason regardless of the branch under test.
            // `fetchRecord` below then reports back the SAME rev that was
            // already indexed, the way a reverify (an identity event, not
            // a real change) actually plays out.
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.intake({ did, rev: "3m2" }, "c1")
            )

            await withFetchThroughRealOnChange(stub, async () => ({
                rev: "3m1",
                car: new Uint8Array([1]),
                source: PDS,
                signingKey: SIGNING_KEY,
            }))

            expect(spy).not.toHaveBeenCalled()
        })

        it("a confirmed deletion also calls deliverDeclarationPush", async () => {
            const did = "did:plc:push-wiring-deleted"
            const stub = freshStub()
            const spy = await spyOnDeliver(stub)
            await runInDurableObject(stub, (obj: MonitorIngest) =>
                obj.intake({ did, rev: "3m1" }, "c1")
            )

            await withFetchThroughRealOnChange(stub, async () => {
                throw new RecordNotFoundError("RepoNotFound", true)
            })

            expect(spy).toHaveBeenCalledWith(did)
        })
    })
})

describe("snapshot refresh", () => {
    const HOUR = 3_600_000
    const entry = (rev: string, observedAtMs: number) => ({
        rev,
        car: new Uint8Array([7, 7]),
        observedAtMs,
        source: PDS,
        signingKey: SIGNING_KEY,
    })

    it("the alarm refreshes due DIDs after settle and before sealing", async () => {
        const stub = freshStub()
        const log: string[] = []
        const old = Date.now() - 3 * HOUR
        await inMonitorObj(stub, async (obj) => {
            const o = obj as unknown as {
                fetchRecord: (did: string) => Promise<StubFetched>
                verifyRecord: IngestDeps["verify"]
                fetchHeadRev: (did: string) => Promise<{ rev: string; signingKey: string | null }>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.fetchRecord = async (did) => {
                log.push(`fetchRecord ${did}`)
                return { rev: "3m2", car: new Uint8Array([1]), source: PDS, signingKey: SIGNING_KEY }
            }
            o.verifyRecord = stubVerify
            o.fetchHeadRev = async (did) => {
                log.push(`fetchHeadRev ${did}`)
                return { rev: "3m1", signingKey: SIGNING_KEY }
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:refresh-b", "3m1", old, STUB_VERIFIED)
            await kvSnapshotStore(testEnv).putRecord("did:plc:refresh-b", entry("3m1", old))
            await obj.intake({ did: "did:plc:refresh-a", rev: "3m2" }, "1")
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })

        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) =>
            Promise.resolve(
                String(url).includes("listReposByCollection")
                    ? Response.json({ repos: [] })
                    : new Response(null, { status: 200 })
            )) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }

        expect(log.filter((l) => !l.startsWith("seal"))).toEqual([
            "fetchRecord did:plc:refresh-a",
            "fetchHeadRev did:plc:refresh-b",
        ])
        expect(log.indexOf("seal")).toBeGreaterThan(log.indexOf("fetchHeadRev did:plc:refresh-b"))
        const fresh = await kvDeclarationSnapshots(testEnv)("did:plc:refresh-b")
        expect(fresh!.freshAtMs).toBeGreaterThan(old)
        await inMonitorObj(stub, async (obj) => {
            expect(await obj.dueRefresh(Date.now() - HOUR, 10)).toEqual([])
        })
    })

    it("dueRefresh skips deleted and pending DIDs and orders by last check", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:r1", "3m1", 1_000, STUB_VERIFIED)
            await obj.complete("did:plc:r2", "3m1", 2_000, STUB_VERIFIED)
            await obj.complete("did:plc:r3", "3m1", 3_000, STUB_VERIFIED)
            await obj.complete("did:plc:r-deleted", "3m1", 100, STUB_VERIFIED)
            await obj.completeDeletion("did:plc:r-deleted", 200, true)
            await obj.complete("did:plc:r-pending", "3m1", 100, STUB_VERIFIED)
            await obj.owe("did:plc:r-pending", "3m2")
            await obj.complete("did:plc:r-fresh", "3m1", 90_000, STUB_VERIFIED)

            expect(await obj.dueRefresh(50_000, 10)).toEqual([
                "did:plc:r1",
                "did:plc:r2",
                "did:plc:r3",
            ])
            // A check counts as the DID's last confirmation, in either direction.
            await obj.markChecked("did:plc:r1", 60_000)
            await obj.markChecked("did:plc:r3", 10)
            expect(await obj.dueRefresh(50_000, 10)).toEqual(["did:plc:r2", "did:plc:r3"])
            expect(await obj.dueRefresh(50_000, 1)).toEqual(["did:plc:r2"])
            // A stale check never makes a recently stored DID due.
            await obj.markChecked("did:plc:r-fresh", 10)
            expect(await obj.dueRefresh(50_000, 10)).not.toContain("did:plc:r-fresh")
            // An attempt within the interval takes the DID out until the next one.
            await obj.markAttempted("did:plc:r3", 55_000)
            expect(await obj.dueRefresh(50_000, 10)).toEqual(["did:plc:r2"])
            await obj.markAttempted("did:plc:r3", 10)
            // An attempt from an earlier interval keeps it due, queued behind the rest.
            await obj.markAttempted("did:plc:r2", 40_000)
            expect(await obj.dueRefresh(50_000, 1)).toEqual(["did:plc:r3"])
            expect(await obj.dueRefresh(50_000, 10)).toEqual(["did:plc:r3", "did:plc:r2"])
            // Quiet completion advances the rev without a digest-window entry.
            await obj.completeQuietly("did:plc:r2", "3m9", 1_300_000, STUB_VERIFIED)
            expect(await obj.revOf("did:plc:r2")).toBe("3m9")
            expect(await obj.windowMembers(Math.floor(1_300_000 / 600_000))).toEqual([])
        })
    })

    it("kvDeclarationSnapshots: freshAtMs is the chk: time when its rev matches rec:, else observedAtMs", async () => {
        const store = kvSnapshotStore(testEnv)
        const read = kvDeclarationSnapshots(testEnv)
        await store.putRecord("did:plc:fresh", entry("3m1", 1_000))
        expect((await read("did:plc:fresh"))!.freshAtMs).toBe(1_000)

        await store.putCheck("did:plc:fresh", { rev: "3m1", checkedAtMs: 5_000 })
        const back = await read("did:plc:fresh")
        expect(back!.freshAtMs).toBe(5_000)
        expect([...back!.car]).toEqual([7, 7])

        // A confirmation of an older rev says nothing about this CAR.
        await store.putCheck("did:plc:fresh", { rev: "3m0", checkedAtMs: 9_000 })
        expect((await read("did:plc:fresh"))!.freshAtMs).toBe(1_000)

        // A check older than the fetch never lowers freshness.
        await store.putCheck("did:plc:fresh", { rev: "3m1", checkedAtMs: 500 })
        expect((await read("did:plc:fresh"))!.freshAtMs).toBe(1_000)
    })

    it("kvDeclarationSnapshots: no rec: → null", async () => {
        const store = kvSnapshotStore(testEnv)
        const read = kvDeclarationSnapshots(testEnv)
        expect(await read("did:plc:nothing")).toBeNull()
        await store.putCheck("did:plc:orphan-check", { rev: "3m1", checkedAtMs: 5_000 })
        expect(await read("did:plc:orphan-check")).toBeNull()

        await store.putRecord("did:plc:deleted-rec", entry("3m1", 1_000))
        await store.putCheck("did:plc:deleted-rec", { rev: "3m1", checkedAtMs: 5_000 })
        await store.deleteRecord("did:plc:deleted-rec")
        expect(await read("did:plc:deleted-rec")).toBeNull()
        await store.putRecord("did:plc:deleted-rec", entry("3m1", 2_000))
        expect((await read("did:plc:deleted-rec"))!.freshAtMs).toBe(2_000)
    })
})

describe("stored DID documents", () => {
    interface Row {
        document: string
        as_of: number
        confirmed_at: number
        version: number
    }
    const rowOf = (stub: DurableObjectStub<MonitorIngest>, did: string) =>
        runInDurableObject(stub, (_obj, state) =>
            state.storage.sql
                .exec<Row>(
                    "SELECT document, as_of, confirmed_at, version FROM did_documents WHERE did = ?",
                    did
                )
                .toArray()[0] ?? null
        )
    const record = (
        stub: DurableObjectStub<MonitorIngest>,
        did: string,
        document: DidDocument | null,
        asOf: number
    ) => inMonitorObj(stub, (obj) => obj.recordDidDocument(did, document, asOf))
    const stale = (stub: DurableObjectStub<MonitorIngest>, did: string, asOf: number) =>
        inMonitorObj(stub, (obj) => obj.markDidDocumentStale(did, asOf))

    const docA = (did: string): DidDocument => ({
        id: did,
        service: [{ id: "#atproto_pds", type: "P", serviceEndpoint: "https://a.example" }],
    })
    const docB = (did: string): DidDocument => ({
        id: did,
        service: [{ id: "#atproto_pds", type: "P", serviceEndpoint: "https://b.example" }],
    })

    it("a first recordDidDocument stores the document at its asOf", async () => {
        const stub = freshStub()
        const did = "did:plc:s8first"
        await record(stub, did, docA(did), 1_000)
        expect(await rowOf(stub, did)).toEqual({
            document: canonicalDidDocumentJson(docA(did)),
            as_of: 1_000,
            confirmed_at: 1_000,
            version: 1,
        })
    })

    it("a write older than the stored asOf is dropped", async () => {
        const stub = freshStub()
        const did = "did:plc:s8older"
        await record(stub, did, docB(did), 2_000)
        await record(stub, did, docA(did), 1_999)
        expect(await rowOf(stub, did)).toMatchObject({
            document: canonicalDidDocumentJson(docB(did)),
            as_of: 2_000,
            version: 1,
        })
    })

    it("a newer write with the same content advances only the confirmation time", async () => {
        const stub = freshStub()
        const did = "did:plc:s8same"
        await record(stub, did, docA(did), 1_000)
        await record(stub, did, docA(did), 5_000)
        expect(await rowOf(stub, did)).toMatchObject({ as_of: 5_000, confirmed_at: 5_000, version: 1 })
        await record(stub, did, docB(did), 6_000)
        expect(await rowOf(stub, did)).toMatchObject({ confirmed_at: 6_000, version: 2 })
    })

    it("the directory's document and the render of the same op store as equal content", async () => {
        const stub = freshStub()
        const did = "did:plc:s8order"
        const fetched = {
            "@context": ["a", "b"],
            id: did,
            service: [{ type: "P", id: "#atproto_pds", serviceEndpoint: "https://a.example" }],
        }
        const rendered = {
            service: [{ id: "#atproto_pds", serviceEndpoint: "https://a.example", type: "P" }],
            id: did,
            "@context": ["a", "b"],
        }
        await record(stub, did, fetched as DidDocument, 1_000)
        await record(stub, did, rendered as DidDocument, 2_000)
        expect(await rowOf(stub, did)).toMatchObject({ version: 1, confirmed_at: 2_000 })
    })

    it("a null document is stored as a tombstone, supersedes an older document, and compares equal to a stored null", async () => {
        const stub = freshStub()
        const did = "did:plc:s8null"
        await record(stub, did, docA(did), 1_000)
        await record(stub, did, null, 2_000)
        expect(await rowOf(stub, did)).toMatchObject({ document: "null", version: 2 })
        await record(stub, did, null, 3_000)
        expect(await rowOf(stub, did)).toMatchObject({ document: "null", version: 2, confirmed_at: 3_000 })
        await record(stub, did, docA(did), 1_500)
        expect(await rowOf(stub, did)).toMatchObject({ document: "null" })
    })

    it("two writes for one DID started together land in asOf order", async () => {
        const stub = freshStub()
        const did = "did:plc:s8race"
        await Promise.all([
            record(stub, did, docB(did), 2_000),
            record(stub, did, docA(did), 1_000),
        ])
        expect(await rowOf(stub, did)).toMatchObject({
            document: canonicalDidDocumentJson(docB(did)),
            as_of: 2_000,
        })
    })

    it("a write or stale mark at the stored asOf lands", async () => {
        const stub = freshStub()
        const did = "did:plc:s8tie"
        await record(stub, did, docA(did), 1_000)
        await record(stub, did, docB(did), 1_000)
        expect(await rowOf(stub, did)).toMatchObject({
            document: canonicalDidDocumentJson(docB(did)),
            version: 2,
        })
        await stale(stub, did, 1_000)
        expect(await rowOf(stub, did)).toMatchObject({ confirmed_at: 0, version: 3 })
    })

    it("markDidDocumentStale bumps the version and zeroes the confirmation; a later write restores it", async () => {
        const stub = freshStub()
        const did = "did:plc:s8stale"
        await record(stub, did, docA(did), 1_000)
        await stale(stub, did, 2_000)
        expect(await rowOf(stub, did)).toMatchObject({ as_of: 2_000, confirmed_at: 0, version: 2 })
        await record(stub, did, docA(did), 3_000)
        expect(await rowOf(stub, did)).toMatchObject({ as_of: 3_000, confirmed_at: 3_000, version: 3 })
    })

    it("markDidDocumentStale older than the stored asOf is dropped", async () => {
        const stub = freshStub()
        const did = "did:plc:s8staleold"
        await record(stub, did, docA(did), 5_000)
        await stale(stub, did, 4_999)
        expect(await rowOf(stub, did)).toMatchObject({ confirmed_at: 5_000, version: 1 })
    })

    it("markDidDocumentStale with no row inserts an untrusted placeholder that drops an older fetch", async () => {
        const stub = freshStub()
        const did = "did:plc:s8placeholder"
        await stale(stub, did, 5_000)
        expect(await rowOf(stub, did)).toEqual({
            document: "",
            as_of: 5_000,
            confirmed_at: 0,
            version: 1,
        })
        await record(stub, did, docA(did), 4_000)
        expect(await rowOf(stub, did)).toMatchObject({ document: "", confirmed_at: 0 })
        await record(stub, did, docA(did), 6_000)
        expect(await rowOf(stub, did)).toMatchObject({ confirmed_at: 6_000, version: 2 })
    })

    it("canonicalDidDocumentJson sorts keys recursively, keeps array order, and writes null as \"null\"", () => {
        expect(canonicalDidDocumentJson(null)).toBe("null")
        expect(
            canonicalDidDocumentJson({ b: [{ z: 1, a: 2 }, 3], a: { y: "x", c: null } } as unknown as DidDocument)
        ).toBe('{"a":{"c":null,"y":"x"},"b":[{"a":2,"z":1},3]}')
        expect(canonicalDidDocumentJson({ a: undefined, b: 1 } as unknown as DidDocument)).toBe('{"b":1}')
        expect(canonicalDidDocumentJson([undefined] as unknown as DidDocument)).toBe("[null]")
    })
})

describe("publishing stored DID documents", () => {
    const HALF = STORED_DID_DOCUMENT_MAX_AGE_MS / 2
    const doc = (did: string, endpoint = "https://a.example"): DidDocument => ({
        id: did,
        service: [{ id: "#atproto_pds", type: "P", serviceEndpoint: endpoint }],
    })
    const record = (
        stub: DurableObjectStub<MonitorIngest>,
        did: string,
        document: DidDocument | null,
        asOf: number
    ) => inMonitorObj(stub, (obj) => obj.recordDidDocument(did, document, asOf))
    const publish = (stub: DurableObjectStub<MonitorIngest>, limit = 64) =>
        inMonitorObj(stub, (obj) => obj.publishDidDocuments(limit))
    const kvEntry = async (did: string) =>
        (await kvDidDocuments(testEnv).get(did)) as CachedDidDocument | null

    /** Run `fn` with `records.put` wrapped; the wrapper runs before the real put. */
    function withPut<R>(
        stub: DurableObjectStub<MonitorIngest>,
        before: (obj: MonitorIngest, key: string) => Promise<void>,
        fn: (obj: MonitorIngest) => Promise<R>
    ): Promise<R> {
        return inMonitorObj(stub, async (obj) => {
            const real = obj.env
            const records = Object.create(real.records) as KVNamespace
            records.put = (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
                await before(obj, key)
                return real.records.put(key, value, opts)
            }) as typeof records.put
            obj.env = { ...real, records }
            try {
                return await fn(obj)
            } finally {
                obj.env = real
            }
        })
    }

    it("publishDidDocuments writes a changed document to KV and kvDidDocuments reads it back", async () => {
        const stub = freshStub()
        const did = "did:plc:s9basic"
        await record(stub, did, doc(did), 1_000)
        expect(await publish(stub)).toMatchObject({ published: 1, remaining: 0 })
        expect(await kvEntry(did)).toEqual({ doc: doc(did), fetchedAtMs: 1_000, source: "plc" })
        expect(await publish(stub)).toMatchObject({ published: 0, remaining: 0 })
    })

    it("skips an unchanged document confirmed under half the max age after what KV holds", async () => {
        const stub = freshStub()
        const did = "did:plc:s9skip"
        await record(stub, did, doc(did), 1_000)
        await publish(stub)
        await record(stub, did, doc(did), 1_000 + HALF - 1)
        expect((await publish(stub)).published).toBe(0)
        expect((await kvEntry(did))?.fetchedAtMs).toBe(1_000)
    })

    it("re-publishes an unchanged document confirmed half the max age after what KV holds", async () => {
        const stub = freshStub()
        const did = "did:plc:s9half"
        await record(stub, did, doc(did), 1_000)
        await publish(stub)
        await record(stub, did, doc(did), 1_000 + HALF)
        expect((await publish(stub)).published).toBe(1)
        expect((await kvEntry(did))?.fetchedAtMs).toBe(1_000 + HALF)
    })

    it("re-publishes a document whose KV confirmation predates the current unbroken run", async () => {
        const stub = freshStub()
        const did = "did:plc:s9run"
        await record(stub, did, doc(did), 1_000)
        await publish(stub)
        await inMonitorObj(stub, (obj) => obj.advancePlcCursor(1, 5_000))
        expect((await publish(stub)).published).toBe(0)
        await record(stub, did, doc(did), 6_000)
        expect((await publish(stub)).published).toBe(1)
        expect((await kvEntry(did))?.fetchedAtMs).toBe(6_000)
    })

    it("publishes content changes before re-confirmations", async () => {
        const stub = freshStub()
        const aging = "did:plc:s9aging"
        const changed = "did:plc:s9changed"
        await record(stub, aging, doc(aging), 1_000)
        await publish(stub)
        await record(stub, aging, doc(aging), 1_000 + HALF)
        await record(stub, changed, doc(changed), 2_000)
        expect((await publish(stub, 1)).published).toBe(1)
        expect(await kvEntry(changed)).not.toBeNull()
        expect((await kvEntry(aging))?.fetchedAtMs).toBe(1_000)
    })

    it("stops at limit, leaves the rest for the next call, and reports remaining content changes", async () => {
        const stub = freshStub()
        const dids = ["did:plc:s9lim1", "did:plc:s9lim2", "did:plc:s9lim3"]
        for (const did of dids) await record(stub, did, doc(did), 1_000)
        await inMonitorObj(stub, (obj) => obj.advancePlcCursor(1, 9_000))
        expect(await publish(stub, 2)).toEqual({ published: 2, remaining: 1, coveredThroughMs: null })
        expect(await publish(stub, 2)).toEqual({ published: 1, remaining: 0, coveredThroughMs: 9_000 })
    })

    it("a document recorded while its publish is in flight is published on the next call", async () => {
        const stub = freshStub()
        const did = "did:plc:s9flight"
        await record(stub, did, doc(did, "https://a.example"), 1_000)
        await withPut(
            stub,
            (obj) => obj.recordDidDocument(did, doc(did, "https://b.example"), 2_000),
            (obj) => obj.publishDidDocuments(64)
        )
        expect((await kvEntry(did))?.doc).toEqual(doc(did, "https://a.example"))
        expect((await publish(stub)).published).toBe(1)
        expect((await kvEntry(did))?.doc).toEqual(doc(did, "https://b.example"))
    })

    it("a KV failure leaves the document unpublished", async () => {
        const stub = freshStub()
        const did = "did:plc:s9fail"
        await record(stub, did, doc(did), 1_000)
        const failed = await withPut(
            stub,
            async () => {
                throw new Error("kv down")
            },
            (obj) => obj.publishDidDocuments(64)
        )
        expect(failed).toMatchObject({ published: 0, remaining: 1, coveredThroughMs: null })
        expect(await kvEntry(did)).toBeNull()
        expect((await publish(stub)).published).toBe(1)
        expect(await kvEntry(did)).not.toBeNull()
    })

    it("a stale-marked document, a tombstone or a placeholder removes the KV entry", async () => {
        const stub = freshStub()
        const staled = "did:plc:s9stale"
        const gone = "did:plc:s9gone"
        const fresh = "did:plc:s9placeholder"
        await record(stub, staled, doc(staled), 1_000)
        await record(stub, gone, doc(gone), 1_000)
        await publish(stub)
        expect(await kvEntry(staled)).not.toBeNull()
        expect(await kvEntry(gone)).not.toBeNull()

        await inMonitorObj(stub, (obj) => obj.markDidDocumentStale(staled, 2_000))
        await record(stub, gone, null, 2_000)
        await inMonitorObj(stub, (obj) => obj.markDidDocumentStale(fresh, 2_000))
        expect((await publish(stub)).published).toBe(3)
        expect(await kvEntry(staled)).toBeNull()
        expect(await kvEntry(gone)).toBeNull()
        expect(await kvEntry(fresh)).toBeNull()

        await record(stub, staled, doc(staled), 3_000)
        expect((await publish(stub)).published).toBe(1)
        expect(await kvEntry(staled)).toMatchObject({ fetchedAtMs: 3_000 })
    })

    it("a published document carries source plc or web by DID method", async () => {
        const stub = freshStub()
        const web = "did:web:s9.example.com"
        const plc = "did:plc:s9source"
        await record(stub, web, doc(web), 1_000)
        await record(stub, plc, doc(plc), 1_000)
        await publish(stub)
        expect((await kvEntry(web))?.source).toBe("web")
        expect((await kvEntry(plc))?.source).toBe("plc")
    })

    it("coveredThroughMs is the high-water taken before selection; a render injected through a KV put is not counted covered", async () => {
        const stub = freshStub()
        const did = "did:plc:s9covered"
        expect((await publish(stub)).coveredThroughMs).toBeNull()
        await inMonitorObj(stub, (obj) => obj.advancePlcCursor(1, 7_000))
        await record(stub, did, doc(did, "https://a.example"), 1_000)
        const first = await withPut(
            stub,
            async (obj) => {
                await obj.advancePlcCursor(2, 8_000)
                await obj.recordDidDocument(did, doc(did, "https://b.example"), 8_000)
            },
            (obj) => obj.publishDidDocuments(64)
        )
        expect(first).toMatchObject({ remaining: 1, coveredThroughMs: null })
        expect((await publish(stub)).coveredThroughMs).toBe(8_000)
    })

    it("a cursor that advances during a pass is not counted covered by it", async () => {
        const stub = freshStub()
        const did = "did:plc:s9snapshot"
        await inMonitorObj(stub, (obj) => obj.advancePlcCursor(1, 7_000))
        await record(stub, did, doc(did), 1_000)
        const pass = await withPut(
            stub,
            (obj) => obj.advancePlcCursor(2, 8_000),
            (obj) => obj.publishDidDocuments(64)
        )
        expect(pass).toMatchObject({ remaining: 0, coveredThroughMs: 7_000 })
    })

    it("kvDidDocuments reads a missing or malformed entry as null", async () => {
        const read = (did: string) => kvDidDocuments(testEnv).get(did)
        expect(await read("did:plc:s9missing")).toBeNull()
        const good = { doc: { id: "did:plc:s9bad" }, fetchedAtMs: 5, source: "plc" }
        const bad: Record<string, string> = {
            "did:plc:s9bad1": "not json",
            "did:plc:s9bad2": JSON.stringify({ ...good, doc: null }),
            "did:plc:s9bad3": JSON.stringify({ ...good, doc: { id: 7 } }),
            "did:plc:s9bad4": JSON.stringify({ ...good, fetchedAtMs: "5" }),
            "did:plc:s9bad5": JSON.stringify({ ...good, source: "other" }),
            "did:plc:s9bad6": JSON.stringify([good]),
        }
        for (const [did, value] of Object.entries(bad)) {
            await testEnv.records.put(`doc:${did}`, value)
            expect(await read(did)).toBeNull()
        }
        await testEnv.records.put("doc:did:plc:s9ok", JSON.stringify(good))
        expect(await read("did:plc:s9ok")).toEqual(good)
    })
})

describe("wiring stored DID documents into the monitor", () => {
    const rowOf = (stub: DurableObjectStub<MonitorIngest>, did: string) =>
        runInDurableObject(stub, (_obj, state) =>
            state.storage.sql
                .exec<{ document: string; as_of: number; confirmed_at: number }>(
                    "SELECT document, as_of, confirmed_at FROM did_documents WHERE did = ?",
                    did
                )
                .toArray()[0] ?? null
        )

    it("settle through the real deps records the fetched record's DID document", async () => {
        const stub = freshStub()
        const did = "did:plc:s10settle"
        const document: DidDocument = { id: did }
        await inMonitorObj(stub, async (obj) => {
            await obj.intake({ did, rev: "3m1" }, "1")
            const realDeps = (obj as unknown as { deps(): IngestDeps }).deps()
            await settleDue({
                ...realDeps,
                fetchRecord: async () => ({
                    rev: "3m1",
                    car: new Uint8Array([1]),
                    source: PDS,
                    signingKey: SIGNING_KEY,
                    didDocument: { document, fetchedAtMs: 100_000 },
                }),
            })
        })
        expect(await rowOf(stub, did)).toEqual({
            document: canonicalDidDocumentJson(document),
            as_of: 100_000 - FETCH_AS_OF_SKEW_MS,
            confirmed_at: 100_000 - FETCH_AS_OF_SKEW_MS,
        })
    })

    it("the default fetchHeadRev records the document it resolved through", async () => {
        const stub = freshStub()
        const did = "did:plc:s10head"
        const original = globalThis.fetch
        const before = Date.now()
        globalThis.fetch = ((input: RequestInfo | URL) => {
            const url = String(input)
            if (url.startsWith("https://plc.directory/")) {
                return Promise.resolve(
                    Response.json({
                        id: did,
                        service: [
                            {
                                id: "#atproto_pds",
                                type: "AtprotoPersonalDataServer",
                                serviceEndpoint: PDS,
                            },
                        ],
                    })
                )
            }
            if (url.includes("sync.getLatestCommit")) {
                return Promise.resolve(Response.json({ cid: "bafy", rev: "3m5" }))
            }
            return Promise.resolve(new Response(null, { status: 404 }))
        }) as typeof fetch
        try {
            const rev = await inMonitorObj(stub, (obj) =>
                (
                    obj as unknown as {
                        fetchHeadRev(did: string): Promise<{ rev: string; signingKey: string | null }>
                    }
                ).fetchHeadRev(did)
            )
            expect(rev).toEqual({ rev: "3m5", signingKey: null })
        } finally {
            globalThis.fetch = original
        }
        const row = await rowOf(stub, did)
        expect(row?.document).toContain(`"id":"${did}"`)
        const after = Date.now()
        expect(row?.as_of).toBeGreaterThanOrEqual(before - FETCH_AS_OF_SKEW_MS)
        expect(row?.as_of).toBeLessThanOrEqual(after - FETCH_AS_OF_SKEW_MS)
    })

    async function alarmWith(publish: () => Promise<unknown>) {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            const o = obj as unknown as {
                publishDidDocuments: (limit: number) => Promise<unknown>
                windowMembers: (w: number) => Promise<string[]>
                fetchHeadRev: (did: string) => Promise<{ rev: string; signingKey: string | null }>
            }
            o.fetchHeadRev = async (did) => {
                log.push(`refresh ${did}`)
                return { rev: "3m1", signingKey: SIGNING_KEY }
            }
            o.publishDidDocuments = async (limit) => {
                log.push(`publish ${limit}`)
                return publish()
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            // A completion three hours back makes a digest window due, which
            // is what makes the alarm seal (and so reach `windowMembers`).
            await obj.complete("did:plc:s10alarm", "3m1", Date.now() - 3 * 3_600_000, STUB_VERIFIED)
            await kvSnapshotStore(testEnv).putRecord("did:plc:s10alarm", {
                rev: "3m1",
                car: new Uint8Array([7]),
                observedAtMs: Date.now() - 3 * 3_600_000,
                source: PDS,
                signingKey: SIGNING_KEY,
                verifiedWith: SIGNING_KEY,
                cid: "bafyreistub",
            })
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) =>
            Promise.resolve(
                String(url).includes("listReposByCollection")
                    ? Response.json({ repos: [] })
                    : new Response(null, { status: 200 })
            )) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }
        return log
    }

    it("the alarm publishes documents ahead of the sweep and the refresh pass, and a publish failure does not skip sealing", async () => {
        const ok = await alarmWith(async () => ({ published: 0, remaining: 0, coveredThroughMs: null }))
        const refresh = ok.indexOf("refresh did:plc:s10alarm")
        expect(refresh).toBeGreaterThanOrEqual(0)
        expect(ok).toContain("publish 64")
        expect(ok.indexOf("publish 64")).toBeLessThan(refresh)
        expect(ok.indexOf("seal")).toBeGreaterThan(refresh)

        const failed = await alarmWith(async () => {
            throw new Error("kv down")
        })
        expect(failed).toContain("publish 64")
        expect(failed).toContain("seal")
    })
})

describe("the PLC export cursor", () => {
    const URL_A = "https://plc.example/export/stream"
    const URL_B = "https://other.example/export/stream"
    const cursorRow = (stub: DurableObjectStub<MonitorIngest>) =>
        runInDurableObject(stub, (_obj, state) => {
            const row = state.storage.sql
                .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
                .toArray()[0]
            return row === undefined ? null : (JSON.parse(row.v) as Record<string, unknown>)
        })
    /** Point the object at a stream URL; unset, it persists nothing. */
    const withUrl = (obj: MonitorIngest, url: string | undefined) => {
        obj.env = { ...obj.env, PLC_EXPORT_STREAM_URL: url }
    }

    it("a permanently deleted DID is not watched", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:s11gone", "3m1", 1_000, STUB_VERIFIED)
            await obj.completeDeletion("did:plc:s11gone", 2_000, true)
            expect(await obj.isDeleted("did:plc:s11gone")).toBe(true)
            expect(await obj.isWatched("did:plc:s11gone")).toBe(false)
            await obj.completeDeletion("did:plc:s11neverindexed", 2_000, true)
            expect(await obj.isWatched("did:plc:s11neverindexed")).toBe(false)
        })
    })

    it("advancePlcCursor never lowers the high-water seq or createdAt", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(5, 500)
            await obj.advancePlcCursor(9, 900)
            await obj.advancePlcCursor(3, 100)
            await obj.persistPlcCursor()
        })
        expect(await cursorRow(stub)).toMatchObject({ url: URL_A, seq: 9 })
        const pass = await inMonitorObj(stub, (obj) => obj.publishDidDocuments(1))
        expect(pass.coveredThroughMs).toBe(900)
    })

    it("the cursor is persisted on alarm and read back for the same URL", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
            await obj.advancePlcCursor(2, 2_000)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) =>
            Promise.resolve(
                String(url).includes("listReposByCollection")
                    ? Response.json({ repos: [] })
                    : new Response(null, { status: 200 })
            )) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }
        expect(await cursorRow(stub)).toMatchObject({ url: URL_A, seq: 2 })
        expect(await inMonitorObj(stub, (obj) => obj.readPlcCursor())).toBe(2)
    })

    it("persists on the first frame, then at most every 5 s on later frames", async () => {
        const stub = freshStub()
        const now = vi.spyOn(Date, "now")
        try {
            await inMonitorObj(stub, async (obj) => {
                withUrl(obj, URL_A)
                now.mockReturnValue(100_000)
                await obj.advancePlcCursor(1, 1_000)
                now.mockReturnValue(104_999)
                await obj.advancePlcCursor(2, 2_000)
            })
            expect(await cursorRow(stub)).toMatchObject({ seq: 1 })
            await inMonitorObj(stub, async (obj) => {
                now.mockReturnValue(105_000)
                await obj.advancePlcCursor(3, 3_000)
            })
            expect(await cursorRow(stub)).toMatchObject({ seq: 3 })
        } finally {
            now.mockRestore()
        }
    })

    it("persists nothing while PLC_EXPORT_STREAM_URL is unset", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, undefined)
            await obj.advancePlcCursor(1, 1_000)
            await obj.persistPlcCursor()
        })
        expect(await cursorRow(stub)).toBeNull()
    })

    it("readPlcCursor answers null when the stored cursor was for another URL, and drops it", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(4, 4_000)
            obj.persistPlcCursor()
        })
        await evictDurableObject(stub)
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            expect(await obj.readPlcCursor()).toBe(4)
        })
        await evictDurableObject(stub)
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_B)
            expect(await obj.readPlcCursor()).toBeNull()
        })
        expect(await cursorRow(stub)).toBeNull()
        const fresh = freshStub()
        await inMonitorObj(fresh, async (obj) => {
            withUrl(obj, URL_A)
            expect(await obj.readPlcCursor()).toBeNull()
        })
    })

    it("resetPlcCursor clears the stored row and the in-memory seq, so a later flush cannot restore it", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(7, 7_000)
            await obj.persistPlcCursor()
            expect(await obj.readPlcCursor()).toBe(7)
            await obj.resetPlcCursor()
            expect((await obj.publishDidDocuments(1)).coveredThroughMs).toBeNull()
            await obj.persistPlcCursor()
            expect(await obj.readPlcCursor()).toBeNull()
            await obj.advancePlcCursor(1, 9_000)
            expect(await obj.readPlcCursor()).toBe(1)
        })
        expect(await cursorRow(stub)).toMatchObject({ seq: 1, continuousSinceMs: 9_000 })
    })

    it("intakePlcEvent through the real object stores a watched DID's render and owes its key update, and ignores an unwatched DID", async () => {
        const stub = freshStub()
        const watched = "did:plc:s11watched"
        const unwatched = "did:plc:s11unwatched"
        const document: DidDocument = { id: watched }
        const event = (did: string, seq: number, createdAtMs: number): PlcExportEvent => ({
            seq,
            did,
            createdAtMs,
            update: { kind: "put", key: "zK", asOfMs: createdAtMs },
            change: { kind: "render", document: { id: did } },
        })
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.complete(watched, "3m1", 1_000, STUB_VERIFIED)
            expect(await intakePlcEvent(obj, event(unwatched, 10, 5_000), obj)).toBe("ignored")
            expect(await intakePlcEvent(obj, event(watched, 11, 6_000), obj)).toBe("owed")
            obj.persistPlcCursor()
        })
        expect(await cursorRow(stub)).toMatchObject({ seq: 11, continuousSinceMs: 5_000 })
        const rows = await runInDurableObject(stub, (_obj, state) => ({
            docs: state.storage.sql
                .exec<{ did: string; document: string }>("SELECT did, document FROM did_documents")
                .toArray(),
            pending: state.storage.sql
                .exec<{ did: string; rev: string }>("SELECT did, rev FROM pending")
                .toArray(),
            keys: state.storage.sql
                .exec<{ did: string }>("SELECT did FROM key_updates")
                .toArray()
                .map((r) => r.did),
        }))
        expect(rows.docs).toEqual([{ did: watched, document: canonicalDidDocumentJson(document) }])
        expect(rows.pending).toEqual([{ did: watched, rev: "3m1" }])
        expect(rows.keys).toEqual([watched])
    })
})

describe("PLC stream coverage", () => {
    const URL_A = "https://plc.example/export/stream"
    const URL_B = "https://other.example/export/stream"
    const withUrl = (obj: MonitorIngest, url: string | undefined) => {
        obj.env = { ...obj.env, PLC_EXPORT_STREAM_URL: url }
    }
    const marker = async () => {
        const text = await testEnv.records.get("plc:coverage")
        return text === null ? null : (JSON.parse(text) as Record<string, unknown>)
    }
    const cursorRow = (stub: DurableObjectStub<MonitorIngest>) =>
        runInDurableObject(stub, (_obj, state) => {
            const row = state.storage.sql
                .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
                .toArray()[0]
            return row === undefined ? null : (JSON.parse(row.v) as Record<string, unknown>)
        })

    it("no coverage is published before a run's cursor row is persisted", async () => {
        await testEnv.records.delete("plc:coverage")
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, undefined)
            await obj.advancePlcCursor(1, 1_000)
            withUrl(obj, URL_A)
            await obj.publishPlcCoverage(1_000)
        })
        expect(await marker()).toBeNull()
        await inMonitorObj(stub, async (obj) => {
            await obj.persistPlcCursor()
            await obj.publishPlcCoverage(1_000)
        })
        expect(await marker()).toEqual({
            url: URL_A,
            continuousSinceMs: 1_000,
            coveredThroughMs: 1_000,
        })
    })

    it("publishes nothing without a stream URL or without any covered time", async () => {
        await testEnv.records.delete("plc:coverage")
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
            await obj.publishPlcCoverage(null)
            withUrl(obj, undefined)
            await obj.publishPlcCoverage(1_000)
            withUrl(obj, "")
            await obj.publishPlcCoverage(1_000)
        })
        expect(await marker()).toBeNull()
    })

    it("a drained publish advances coveredThroughMs to the value given, and kvPlcCoverage reads it", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
            await obj.publishPlcCoverage(1_000)
            await obj.publishPlcCoverage(4_000)
        })
        expect(await kvPlcCoverage(testEnv)()).toEqual({
            url: URL_A,
            continuousSinceMs: 1_000,
            coveredThroughMs: 4_000,
        })
    })

    it("a null coveredThroughMs re-publishes the previous value", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
            await obj.publishPlcCoverage(3_000)
            await testEnv.records.delete("plc:coverage")
            await obj.publishPlcCoverage(null)
        })
        expect(await marker()).toMatchObject({ coveredThroughMs: 3_000 })
    })

    it("a cursor reset starts a new run at the next frame's createdAt", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
            await obj.publishPlcCoverage(2_000)
            await obj.resetPlcCursor()
            await testEnv.records.delete("plc:coverage")
            await obj.publishPlcCoverage(null)
            expect(await marker()).toBeNull()
            withUrl(obj, undefined)
            await obj.advancePlcCursor(2, 5_000)
            withUrl(obj, URL_A)
            await obj.publishPlcCoverage(5_000)
            expect(await marker()).toBeNull()
            await obj.persistPlcCursor()
            await obj.publishPlcCoverage(null)
            expect(await marker()).toBeNull()
            await obj.publishPlcCoverage(5_000)
        })
        expect(await marker()).toEqual({
            url: URL_A,
            continuousSinceMs: 5_000,
            coveredThroughMs: 5_000,
        })
    })

    it("a resume from a stored cursor keeps the run's continuousSinceMs", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
        })
        await evictDurableObject(stub)
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            expect(await obj.readPlcCursor()).toBe(1)
            await obj.advancePlcCursor(2, 9_000)
            await obj.publishPlcCoverage(9_000)
        })
        expect(await cursorRow(stub)).toMatchObject({ seq: 2, continuousSinceMs: 1_000 })
        expect(await marker()).toMatchObject({ continuousSinceMs: 1_000, coveredThroughMs: 9_000 })
    })

    it("a changed PLC_EXPORT_STREAM_URL starts a new run", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(1, 1_000)
        })
        await evictDurableObject(stub)
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_B)
            expect(await obj.readPlcCursor()).toBeNull()
            await obj.advancePlcCursor(5, 7_000)
            await obj.publishPlcCoverage(7_000)
        })
        expect(await cursorRow(stub)).toMatchObject({ url: URL_B, seq: 5, continuousSinceMs: 7_000 })
        expect(await marker()).toEqual({
            url: URL_B,
            continuousSinceMs: 7_000,
            coveredThroughMs: 7_000,
        })
    })

    it("kvPlcCoverage reads a missing or malformed entry as null", async () => {
        const read = kvPlcCoverage(testEnv)
        await testEnv.records.delete("plc:coverage")
        expect(await read()).toBeNull()
        const good = { url: URL_A, continuousSinceMs: 1, coveredThroughMs: 2 }
        for (const bad of [
            "not json",
            "[1]",
            JSON.stringify({ ...good, url: 5 }),
            JSON.stringify({ ...good, continuousSinceMs: "1" }),
            JSON.stringify({ ...good, coveredThroughMs: null }),
            JSON.stringify({ url: URL_A }),
        ]) {
            await testEnv.records.put("plc:coverage", bad)
            expect(await read()).toBeNull()
        }
        await testEnv.records.put("plc:coverage", JSON.stringify(good))
        expect(await read()).toEqual(good)
    })
})

describe("PLC export consumer: frames, sockets and the alarm", () => {
    const URL_A = "https://plc.example/export/stream"
    const WATCHED = "did:plc:s13watched"
    const OP = {
        sig: "x",
        prev: null,
        type: "plc_operation",
        services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.example" } },
        alsoKnownAs: ["at://s13.example"],
        rotationKeys: ["did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg"],
        verificationMethods: { atproto: "did:key:zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF" },
    }
    const frame = (did: string, seq: number, createdAt = "2026-01-01T00:00:00.000Z") =>
        JSON.stringify({ did, cid: "bafy", seq, createdAt, operation: OP, type: "sequenced_op" })
    const withUrl = (obj: MonitorIngest, url: string | undefined) => {
        obj.env = { ...obj.env, PLC_EXPORT_STREAM_URL: url }
    }
    type Internals = {
        plcSocket: unknown
        enqueuePlcFrame(raw: string): Promise<void>
        onPlcClose(ws: WebSocket | null, reason: string): Promise<void>
        connectPlc(): Promise<void>
    }
    const internals = (obj: MonitorIngest) => obj as unknown as Internals

    /** Record the URLs the object asks fetch for while `fn` runs; every request fails to upgrade. */
    async function recordingFetch(fn: () => Promise<unknown>): Promise<URL[]> {
        const seen: URL[] = []
        const original = globalThis.fetch
        globalThis.fetch = ((input: RequestInfo | URL) => {
            seen.push(new URL(String(input)))
            return Promise.resolve(new Response(null, { status: 200 }))
        }) as typeof fetch
        try {
            await fn().catch(() => {})
        } finally {
            globalThis.fetch = original
        }
        return seen
    }

    it("connectPlc is a no-op when PLC_EXPORT_STREAM_URL is unset", async () => {
        const stub = freshStub()
        let outcome = "not run"
        const seen = await recordingFetch(async () => {
            outcome = await inMonitorObj(stub, async (obj) => {
                withUrl(obj, undefined)
                return internals(obj).connectPlc().then(
                    () => "resolved",
                    (err) => String(err)
                )
            })
        })
        expect(outcome).toBe("resolved")
        expect(seen).toEqual([])
    })

    it("connectPlc sends the stored seq as the cursor parameter, and none when there is no cursor for this URL", async () => {
        const stub = freshStub()
        const fresh = await recordingFetch(() =>
            inMonitorObj(stub, async (obj) => {
                withUrl(obj, URL_A)
                await internals(obj).connectPlc()
            })
        )
        expect(fresh).toHaveLength(1)
        expect(fresh[0]!.origin + fresh[0]!.pathname).toBe(URL_A)
        expect(fresh[0]!.searchParams.has("cursor")).toBe(false)

        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(41, 1_000)
        })
        await evictDurableObject(stub)
        const resumed = await recordingFetch(() =>
            inMonitorObj(stub, async (obj) => {
                withUrl(obj, URL_A)
                await internals(obj).connectPlc()
            })
        )
        expect(resumed[0]!.searchParams.get("cursor")).toBe("41")

        await evictDurableObject(stub)
        const other = await recordingFetch(() =>
            inMonitorObj(stub, async (obj) => {
                withUrl(obj, "https://other.example/export/stream")
                await internals(obj).connectPlc()
            })
        )
        expect(other[0]!.searchParams.has("cursor")).toBe(false)
    })

    it("a live object resumes from its newest cursor in memory, not the stored one", async () => {
        const stub = freshStub()
        const seen = await recordingFetch(() =>
            inMonitorObj(stub, async (obj) => {
                withUrl(obj, URL_A)
                await obj.advancePlcCursor(41, 1_000)
                await obj.advancePlcCursor(50, 2_000)
                await internals(obj).connectPlc()
            })
        )
        expect(seen[0]!.searchParams.get("cursor")).toBe("50")
    })

    it("a failed PLC connect does not skip the rest of the alarm", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const o = obj as unknown as {
                connectPlc: () => Promise<void>
                publishDidDocuments: (n: number) => Promise<unknown>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.connectPlc = async () => {
                log.push("connectPlc")
                throw new Error("plc down")
            }
            o.publishDidDocuments = async () => {
                log.push("publish")
                return { published: 0, remaining: 0, coveredThroughMs: null }
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:s13alarm", "3m1", Date.now() - 3 * 3_600_000, STUB_VERIFIED)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await runAlarm(stub)
        expect(log).toContain("connectPlc")
        expect(log.indexOf("publish")).toBeGreaterThan(log.indexOf("connectPlc"))
        expect(log).toContain("seal")
    })

    async function runAlarm(stub: DurableObjectStub<MonitorIngest>) {
        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) =>
            Promise.resolve(
                String(url).includes("listReposByCollection")
                    ? Response.json({ repos: [] })
                    : new Response(null, { status: 200 })
            )) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // connect() has no real socket to open here.
        } finally {
            globalThis.fetch = original
        }
    }

    it("the alarm persists the PLC cursor before publishing coverage and before sealing", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const o = obj as unknown as {
                connectPlc: () => Promise<void>
                persistPlcCursor: () => Promise<void>
                publishDidDocuments: (n: number) => Promise<unknown>
                publishPlcCoverage: (through: number | null) => Promise<void>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.connectPlc = async () => {}
            const persist = obj.persistPlcCursor.bind(obj)
            o.persistPlcCursor = async () => {
                log.push("persist")
                return persist()
            }
            o.publishDidDocuments = async () => {
                log.push("publish")
                return { published: 0, remaining: 0, coveredThroughMs: 1_234 }
            }
            o.publishPlcCoverage = async (through) => {
                log.push(`coverage ${through}`)
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:s13order", "3m1", Date.now() - 3 * 3_600_000, STUB_VERIFIED)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await runAlarm(stub)
        expect([...new Set(log)]).toEqual(["persist", "publish", "coverage 1234", "seal"])
    })

    it("a publish failure still re-publishes the previous coverage and does not skip sealing", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const o = obj as unknown as {
                connectPlc: () => Promise<void>
                publishDidDocuments: (n: number) => Promise<unknown>
                publishPlcCoverage: (through: number | null) => Promise<void>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.connectPlc = async () => {}
            o.publishDidDocuments = async () => {
                throw new Error("kv down")
            }
            o.publishPlcCoverage = async (through) => {
                log.push(`coverage ${through}`)
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:s13fail", "3m1", Date.now() - 3 * 3_600_000, STUB_VERIFIED)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await runAlarm(stub)
        expect([...new Set(log)]).toEqual(["coverage null", "seal"])
    })

    it("a failing cursor persist and a failing coverage publish each leave the rest of the alarm to run", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const o = obj as unknown as {
                connectPlc: () => Promise<void>
                persistPlcCursor: () => void
                publishDidDocuments: (n: number) => Promise<unknown>
                publishPlcCoverage: (through: number | null) => Promise<void>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.connectPlc = async () => {}
            o.persistPlcCursor = () => {
                log.push("persist")
                throw new Error("sqlite down")
            }
            o.publishDidDocuments = async () => {
                log.push("publish")
                return { published: 0, remaining: 0, coveredThroughMs: null }
            }
            o.publishPlcCoverage = async () => {
                log.push("coverage")
                throw new Error("kv down")
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:s13both", "3m1", Date.now() - 3 * 3_600_000, STUB_VERIFIED)
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await runAlarm(stub)
        expect([...new Set(log)]).toEqual(["persist", "publish", "coverage", "seal"])
    })

    it("frames are handled strictly in order on one chain, and a bad frame does not break it", async () => {
        const stub = freshStub()
        const other = "did:plc:s13unwatched"
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.complete(WATCHED, "3m1", 1_000, STUB_VERIFIED)
            const advanced: number[] = []
            const advance = obj.advancePlcCursor.bind(obj)
            obj.advancePlcCursor = async (seq, createdAtMs) => {
                advanced.push(seq)
                return advance(seq, createdAtMs)
            }
            const owe = obj.oweKeyUpdate.bind(obj)
            obj.oweKeyUpdate = async (did, update, seq, createdAtMs) => {
                if (seq !== undefined) advanced.push(seq)
                return owe(did, update, seq, createdAtMs)
            }
            const real = obj.recordDidDocument.bind(obj)
            let first = true
            obj.recordDidDocument = async (did, doc, asOf) => {
                if (first) {
                    first = false
                    await new Promise((resolve) => setTimeout(resolve, 20))
                }
                return real(did, doc, asOf)
            }
            const chain = internals(obj)
            await Promise.all([
                chain.enqueuePlcFrame(frame(WATCHED, 1, "2026-01-01T00:00:01.000Z")),
                chain.enqueuePlcFrame("not json"),
                chain.enqueuePlcFrame(frame(other, 2, "2026-01-01T00:00:02.000Z")),
                chain.enqueuePlcFrame(frame(WATCHED, 3, "2026-01-01T00:00:03.000Z")),
            ])
            await obj.persistPlcCursor()
            expect(advanced).toEqual([1, 2, 3])
        })
        const rows = await runInDurableObject(stub, (_obj, state) => ({
            docs: state.storage.sql
                .exec<{ did: string; as_of: number }>("SELECT did, as_of FROM did_documents")
                .toArray(),
            cursor: JSON.parse(
                state.storage.sql
                    .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
                    .one().v
            ) as { seq: number },
        }))
        expect(rows.docs).toEqual([{ did: WATCHED, as_of: Date.parse("2026-01-01T00:00:03.000Z") }])
        expect(rows.cursor.seq).toBe(3)
    })

    it("a frame that throws in intake does not stop later frames, and ends the coverage run", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.complete(WATCHED, "3m1", 1_000, STUB_VERIFIED)
            const real = obj.recordDidDocument.bind(obj)
            let calls = 0
            obj.recordDidDocument = async (did, doc, asOf) => {
                calls += 1
                if (calls === 2) throw new Error("sqlite down")
                return real(did, doc, asOf)
            }
            const chain = internals(obj)
            await Promise.all([
                chain.enqueuePlcFrame(frame(WATCHED, 1, "2026-01-01T00:00:01.000Z")),
                chain.enqueuePlcFrame(frame(WATCHED, 2, "2026-01-01T00:00:02.000Z")),
                chain.enqueuePlcFrame(frame(WATCHED, 3, "2026-01-01T00:00:05.000Z")),
            ])
            await obj.persistPlcCursor()
            await obj.publishPlcCoverage(Date.parse("2026-01-01T00:00:05.000Z"))
        })
        const docs = await runInDurableObject(stub, (_obj, state) =>
            state.storage.sql.exec<{ as_of: number }>("SELECT as_of FROM did_documents").toArray()
        )
        expect(docs).toEqual([{ as_of: Date.parse("2026-01-01T00:00:05.000Z") }])
        const marker = JSON.parse((await testEnv.records.get("plc:coverage"))!) as {
            continuousSinceMs: number
        }
        expect(marker.continuousSinceMs).toBe(Date.parse("2026-01-01T00:00:05.000Z"))
    })

    it("closing with OutdatedCursor or FutureCursor resets the cursor; any other close keeps it; a close re-enables reconnecting", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const chain = internals(obj)
            const socket = {} as WebSocket
            const open = () => ((obj as unknown as { plcSocket: unknown }).plcSocket = socket)
            await obj.advancePlcCursor(8, 8_000)
            open()
            await chain.onPlcClose(socket, "ConsumerTooSlow")
            expect(await obj.readPlcCursor()).toBe(8)
            expect(chain.plcSocket).toBeNull()
            open()
            await chain.onPlcClose(socket, "OutdatedCursor")
            expect(await obj.readPlcCursor()).toBeNull()
            expect(chain.plcSocket).toBeNull()
            await obj.advancePlcCursor(9, 9_000)
            open()
            await chain.onPlcClose(socket, "FutureCursor")
            expect(await obj.readPlcCursor()).toBeNull()
            expect(chain.plcSocket).toBeNull()
        })
    })

    it("a permanently deleted DID's stored document still follows the stream, with nothing owed", async () => {
        const stub = freshStub()
        const did = "did:plc:s13deleted"
        const document: DidDocument = { id: did, alsoKnownAs: ["at://rotated.example"] }
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.recordDidDocument(did, { id: did }, 1_000)
            await obj.complete(did, "3m1", 1_000, STUB_VERIFIED)
            await obj.completeDeletion(did, 2_000, true)
            const event: PlcExportEvent = {
                seq: 5,
                did,
                createdAtMs: 9_000,
                update: { kind: "put", key: "zK", asOfMs: 9_000 },
                change: { kind: "render", document },
            }
            expect(await intakePlcEvent(obj, event, obj)).toBe("ignored")
        })
        const rows = await runInDurableObject(stub, (_obj, state) => ({
            doc: state.storage.sql
                .exec<{ document: string; as_of: number }>("SELECT document, as_of FROM did_documents")
                .toArray(),
            keys: state.storage.sql.exec("SELECT did FROM key_updates").toArray(),
            pending: state.storage.sql.exec("SELECT did FROM pending").toArray(),
        }))
        expect(rows.doc).toEqual([{ document: canonicalDidDocumentJson(document), as_of: 9_000 }])
        expect(rows.keys).toEqual([])
        expect(rows.pending).toEqual([])
    })

    it("a failing cursor reset on close still frees the socket slot", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            const internal = obj as unknown as {
                plcSocket: unknown
                onPlcClose(ws: WebSocket | null, reason: string): Promise<void>
            }
            const socket = {} as WebSocket
            internal.plcSocket = socket
            obj.resetPlcCursor = async () => {
                throw new Error("sqlite down")
            }
            await internal.onPlcClose(socket, "OutdatedCursor")
            expect(internal.plcSocket).toBeNull()
        })
    })

    it("a backfill sweep that throws does not stop the documents and coverage from being published", async () => {
        const stub = freshStub()
        const log: string[] = []
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const o = obj as unknown as {
                connectPlc: () => Promise<void>
                publishDidDocuments: (n: number) => Promise<unknown>
                publishPlcCoverage: (through: number | null) => Promise<void>
            }
            o.connectPlc = async () => {}
            o.publishDidDocuments = async () => {
                log.push("publish")
                return { published: 0, remaining: 0, coveredThroughMs: 77 }
            }
            o.publishPlcCoverage = async (through) => {
                log.push(`coverage ${through}`)
            }
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        const original = globalThis.fetch
        globalThis.fetch = ((url: RequestInfo | URL) =>
            String(url).includes("listReposByCollection")
                ? Promise.reject(new Error("relay down"))
                : Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // The sweep's failure surfaces from the alarm, as it always did.
        } finally {
            globalThis.fetch = original
        }
        expect(log).toEqual(["publish", "coverage 77"])
    })

    it("a socket error frees the slot for its own socket only", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            const internal = obj as unknown as { plcSocket: unknown; onPlcError(ws: WebSocket): void }
            const old = {} as WebSocket
            const live = {} as WebSocket
            internal.plcSocket = live
            internal.onPlcError(old)
            expect(internal.plcSocket).toBe(live)
            internal.onPlcError(live)
            expect(internal.plcSocket).toBeNull()
        })
    })

    it("a late close from a replaced socket neither resets the cursor nor drops the live socket", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            const chain = internals(obj)
            const old = {} as WebSocket
            const live = {} as WebSocket
            await obj.advancePlcCursor(8, 8_000)
            ;(obj as unknown as { plcSocket: unknown }).plcSocket = live
            await chain.onPlcClose(old, "OutdatedCursor")
            expect(chain.plcSocket).toBe(live)
            expect(await obj.readPlcCursor()).toBe(8)
        })
    })
})

describe("PLC export consumer", () => {
    const PLC_URL = "https://plc.invalid/export/stream"
    const COLLECTION = testEnv.MONITOR_COLLECTION
    const put = (key: string, asOfMs = 1_000) => ({ kind: "put" as const, key, asOfMs })
    const del = { kind: "delete" as const }

    /** Run one alarm with every outbound fetch answered by `answer`; resolves the URLs asked for. */
    async function alarmWithFetch(
        stub: DurableObjectStub<MonitorIngest>,
        answer: (url: string) => Promise<Response> = () =>
            Promise.resolve(new Response(null, { status: 200 }))
    ): Promise<string[]> {
        const urls: string[] = []
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        )
        const original = globalThis.fetch
        globalThis.fetch = ((input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString()
            urls.push(url)
            return answer(url)
        }) as typeof fetch
        try {
            await runDurableObjectAlarm(stub)
        } catch {
            // The stubbed network fails every other stage of the tick.
        } finally {
            globalThis.fetch = original
        }
        return urls
    }

    /** `env` is shared across objects in this isolate: put it back. */
    async function withPlcUrl<R>(
        obj: MonitorIngest,
        value: string | undefined,
        fn: () => Promise<R> | R
    ): Promise<R> {
        const before = obj.env.PLC_EXPORT_STREAM_URL
        obj.env.PLC_EXPORT_STREAM_URL = value
        try {
            return await fn()
        } finally {
            obj.env.PLC_EXPORT_STREAM_URL = before
        }
    }

    const storedCursor = (stub: DurableObjectStub<MonitorIngest>) =>
        runInDurableObject(stub, async (obj: MonitorIngest, state) => {
            void obj
            const row = state.storage.sql
                .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'plc_cursor'")
                .toArray()[0]
            return row === undefined ? null : (JSON.parse(row.v) as { url: string; seq: number })
        })

    it("KeyUpdateIndex: plc cursor advances with oweKeyUpdate and survives a separate entry", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.oweKeyUpdate("did:plc:a", put("zK"), 42)
        )
        await evictDurableObject(stub)
        const cursor = await runInDurableObject(stub, (obj: MonitorIngest) => obj.readPlcCursor())
        expect(cursor).toBe(42)
    })

    it("KeyUpdateIndex: a cursor stored for a different PLC_EXPORT_STREAM_URL reads as null", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.oweKeyUpdate("did:plc:a", put("zK"), 42)
        )
        await evictDurableObject(stub)
        const cursor = await runInDurableObject(stub, (obj: MonitorIngest) =>
            withPlcUrl(obj, "https://other.invalid/export/stream", () => obj.readPlcCursor())
        )
        expect(cursor).toBeNull()
    })

    it("KeyUpdateIndex: advancePlcCursor(10), oweKeyUpdate(…, 11), alarm → stored cursor 11 (one high-water seq)", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.advancePlcCursor(10)
            await obj.oweKeyUpdate("did:plc:a", put("zK"), 11)
        })
        await alarmWithFetch(stub)
        expect(await storedCursor(stub)).toMatchObject({ url: PLC_URL, seq: 11 })

        // A lazily flushed advance must not drag a newer stored seq back.
        const other = freshStub()
        await runInDurableObject(other, async (obj: MonitorIngest) => {
            await obj.oweKeyUpdate("did:plc:a", put("zK"), 11)
            await obj.advancePlcCursor(10)
        })
        await alarmWithFetch(other)
        expect(await storedCursor(other)).toMatchObject({ url: PLC_URL, seq: 11 })
    })

    it("KeyUpdateIndex: an advance inside the persist interval is flushed by the alarm", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.advancePlcCursor(10)
            await obj.advancePlcCursor(20)
        })
        expect(await storedCursor(stub)).toMatchObject({ url: PLC_URL, seq: 10 })
        await alarmWithFetch(stub)
        expect(await storedCursor(stub)).toMatchObject({ url: PLC_URL, seq: 20 })
    })

    it("KeyUpdateIndex: an advance below the stored cursor on a cold object does not lower it", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.oweKeyUpdate("did:plc:a", put("zK"), 50)
        )
        await evictDurableObject(stub)
        await runInDurableObject(stub, (obj: MonitorIngest) => obj.advancePlcCursor(40))
        await alarmWithFetch(stub)
        expect(await storedCursor(stub)).toMatchObject({ url: PLC_URL, seq: 50 })
    })

    it("KeyUpdateIndex: resetPlcCursor then alarm → cursor stays null", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.advancePlcCursor(10)
            await obj.resetPlcCursor()
        })
        await alarmWithFetch(stub)
        expect(await storedCursor(stub)).toBeNull()
        expect(await runInDurableObject(stub, (obj: MonitorIngest) => obj.readPlcCursor())).toBeNull()
    })

    it("KeyUpdateIndex: oweKeyUpdate replaces and bumps version; clearKeyUpdate with a stale version is a no-op", async () => {
        const stub = freshStub()
        const result = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.oweKeyUpdate("did:plc:a", put("zOld"))
            const [first] = await obj.dueKeyUpdates(10)
            await obj.oweKeyUpdate("did:plc:a", del)
            await obj.clearKeyUpdate("did:plc:a", first!.version)
            const stillOwed = await obj.dueKeyUpdates(10)
            await obj.clearKeyUpdate("did:plc:a", stillOwed[0]!.version)
            return { first, stillOwed, after: await obj.dueKeyUpdates(10) }
        })
        expect(result.first).toEqual({ did: "did:plc:a", update: put("zOld"), version: 1 })
        expect(result.stillOwed).toEqual([{ did: "did:plc:a", update: del, version: 2 }])
        expect(result.after).toEqual([])
    })

    it("KeyUpdateIndex: a null key and a limit round-trip", async () => {
        const stub = freshStub()
        const owed = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.oweKeyUpdate("did:plc:a", { kind: "put", key: null, asOfMs: 5 })
            await obj.oweKeyUpdate("did:plc:b", del)
            return obj.dueKeyUpdates(1)
        })
        expect(owed).toEqual([
            { did: "did:plc:a", update: { kind: "put", key: null, asOfMs: 5 }, version: 1 },
        ])
    })

    it("alarm connects to PLC_EXPORT_STREAM_URL with cursor=<plc cursor>, or none at the tip", async () => {
        const tip = await alarmWithFetch(freshStub())
        const tipUrl = tip.find((u) => u.startsWith(PLC_URL))
        expect(tipUrl).toBeDefined()
        expect(new URL(tipUrl!).searchParams.has("cursor")).toBe(false)

        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.oweKeyUpdate("did:plc:a", put("zK"), 77)
        )
        await evictDurableObject(stub)
        const resumed = (await alarmWithFetch(stub)).find((u) => u.startsWith(PLC_URL))
        expect(new URL(resumed!).searchParams.get("cursor")).toBe("77")
    })

    it("alarm makes no PLC connect when PLC_EXPORT_STREAM_URL is unset", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) => {
            obj.env.PLC_EXPORT_STREAM_URL = undefined
        })
        let urls: string[]
        try {
            urls = await alarmWithFetch(stub)
        } finally {
            await runInDurableObject(stub, (obj: MonitorIngest) => {
                obj.env.PLC_EXPORT_STREAM_URL = PLC_URL
            })
        }
        expect(urls.some((u) => u.includes("plc.invalid"))).toBe(false)
        expect(urls.some((u) => u.includes("jetstream"))).toBe(true)
    })

    it("a failed PLC connect does not stop the rest of the alarm", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.oweKeyUpdate("did:plc:failconnect", put("zAfter"))
        )
        const urls = await alarmWithFetch(stub, (url) =>
            url.startsWith(PLC_URL)
                ? Promise.reject(new Error("plc down"))
                : Promise.resolve(new Response(null, { status: 200 }))
        )
        expect(urls.some((u) => u.startsWith(PLC_URL))).toBe(true)
        expect(urls.some((u) => u.includes("relay.invalid"))).toBe(true)
        expect(await kvSigningKeyCache(testEnv).get("did:plc:failconnect")).toMatchObject({
            key: "zAfter",
        })
    })

    it("alarm drains owed key updates into sk:", async () => {
        const stub = freshStub()
        const cache = kvSigningKeyCache(testEnv)
        await cache.put("did:plc:drain-del", { key: "zStale", fetchedAtMs: 1 })
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.oweKeyUpdate("did:plc:drain-put", put("zNew", 1_000))
            await obj.oweKeyUpdate("did:plc:drain-del", del)
        })
        await alarmWithFetch(stub)
        expect(await cache.get("did:plc:drain-put")).toEqual({ key: "zNew", fetchedAtMs: 1_000 })
        expect(await cache.get("did:plc:drain-del")).toBeNull()
        expect(await runInDurableObject(stub, (obj: MonitorIngest) => obj.dueKeyUpdates(10))).toEqual([])
    })

    describe("the identity hint through deps()", () => {
        const identity = (did: string) => ({
            kind: "identity" as const,
            did,
            seq: 1,
            timeMs: null,
        })
        const hint = (stub: DurableObjectStub<MonitorIngest>, did: string, consumerUnset: boolean) =>
            runInDurableObject(stub, (obj: MonitorIngest) =>
                withPlcUrl(obj, consumerUnset ? undefined : PLC_URL, async () => {
                    await obj.complete(did, "3m1", 1, STUB_VERIFIED)
                    const deps = (obj as unknown as { deps(): IngestDeps }).deps()
                    const decision = await intake(deps, { collection: COLLECTION }, identity(did), "c")
                    return { decision, owed: (await obj.dueKeyUpdates(10)).map((o) => o.did) }
                })
            )

        it("identity event via deps(): a watched did:web owes a key delete; a watched did:plc owes none while the consumer is configured", async () => {
            expect(await hint(freshStub(), "did:web:example.com", false)).toEqual({
                decision: "reverify",
                owed: ["did:web:example.com"],
            })
            expect(await hint(freshStub(), "did:plc:watched", false)).toEqual({
                decision: "reverify",
                owed: [],
            })
        })

        it("identity event via deps() with the consumer unset: a watched did:plc owes a key delete", async () => {
            expect(await hint(freshStub(), "did:plc:watched", true)).toEqual({
                decision: "reverify",
                owed: ["did:plc:watched"],
            })
        })
    })
})

describe("verifying a fetched record", () => {
    const COLLECTION = testEnv.MONITOR_COLLECTION
    const key = makeKey()
    const verifyRecord = (record: FetchedRecord, did = DID) =>
        runInDurableObject(freshStub(), (obj: MonitorIngest) =>
            (
                obj as unknown as {
                    verifyRecord(did: string, record: FetchedRecord): Promise<unknown>
                }
            ).verifyRecord(did, record)
        )
    const fetched = (car: Uint8Array, signingKey: string | null = key.multikey): FetchedRecord => ({
        car,
        source: PDS,
        signingKey,
    })

    it("a CAR signed by the fetched key verifies with its signed rev and cid", async () => {
        const repo = buildRepoCar({
            did: DID,
            key,
            records: { [`${COLLECTION}/self`]: { $type: COLLECTION, n: 1 } },
        })
        expect(await verifyRecord(fetched(repo.car))).toEqual({
            kind: "verified",
            key: key.multikey,
            rev: "3kaaaaaaaaaaa",
            cid: repo.recordCids[`${COLLECTION}/self`],
        })
    })

    it("a signed exclusion proof is verified-absent", async () => {
        const repo = buildRepoCar({ did: DID, key, records: { "app.bsky.feed.post/3kaaaaaaaaaaa": { $type: "x" } } })
        expect(await verifyRecord(fetched(repo.car))).toEqual({
            kind: "verified-absent",
            key: key.multikey,
            rev: "3kaaaaaaaaaaa",
        })
    })

    it("a CAR signed by another key, a malformed CAR, or a fetch with no key is unverifiable", async () => {
        const repo = buildRepoCar({
            did: DID,
            key,
            records: { [`${COLLECTION}/self`]: { $type: COLLECTION, n: 1 } },
        })
        expect(await verifyRecord(fetched(repo.car, makeKey().multikey))).toEqual({ kind: "unverifiable" })
        expect(await verifyRecord(fetched(new Uint8Array([1, 2, 3])))).toEqual({ kind: "unverifiable" })
        expect(await verifyRecord(fetched(repo.car, null))).toEqual({ kind: "unverifiable" })
    })

    it("the snapshot store round-trips verifiedWith, cid and seenKey", async () => {
        const store = kvSnapshotStore(testEnv)
        await store.putRecord("did:plc:meta", {
            rev: "3m1",
            car: new Uint8Array([9]),
            observedAtMs: 1,
            source: PDS,
            signingKey: SIGNING_KEY,
            verifiedWith: SIGNING_KEY,
            cid: "bafyreimeta",
            seenKey: "zQ3shSeen",
        })
        expect(await store.getRecord("did:plc:meta")).toMatchObject({
            verifiedWith: SIGNING_KEY,
            cid: "bafyreimeta",
            seenKey: "zQ3shSeen",
        })
    })
})

describe("record index and holder state", () => {
    const verified = (cid = "bafyreic1") => ({ cid, verifiedWith: SIGNING_KEY })
    const rows = <T>(stub: DurableObjectStub<MonitorIngest>, query: string) =>
        runInDurableObject(stub, (_obj, state) => state.storage.sql.exec(query).toArray() as T[])

    it("declaration rev in revs and records agree after settle, quiet advance and deletion", async () => {
        const stub = freshStub()
        const revOfRecords = async () =>
            (await runInDurableObject(stub, (obj: MonitorIngest) => obj.recordsOf(DID))).map(
                (r) => r.rev
            )
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.complete(DID, "3m1", Date.now(), verified())
        )
        expect(await revOfRecords()).toEqual(["3m1"])
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.revOf(DID))).toBe("3m1")

        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.completeQuietly(DID, "3m2", Date.now(), verified())
        )
        expect(await revOfRecords()).toEqual(["3m2"])
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.revOf(DID))).toBe("3m2")

        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.completeDeletion(DID, Date.now(), false)
        )
        expect(await revOfRecords()).toEqual([])
        // The rev floor outlives the record.
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.revOf(DID))).toBe("3m2")
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.holderStateOf(DID))).toBe(
            "gone-reversible"
        )
    })

    it("a record row carries the collection, cid and the key it verified under", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.complete(DID, "3m1", Date.now(), verified("bafyreic9"))
        )
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.recordsOf(DID))).toEqual([
            {
                did: DID,
                collection: testEnv.MONITOR_COLLECTION,
                rkey: "self",
                rev: "3m1",
                cid: "bafyreic9",
                verifiedWith: SIGNING_KEY,
            },
        ])
    })

    it("existing revs rows are held after upgrade; deleted rows are gone-permanent", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (_obj, state) => {
            state.storage.sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES ('did:plc:a', '3m1', 1), ('did:plc:b', '3m1', 1)")
            state.storage.sql.exec("INSERT INTO deleted (did, deleted_at) VALUES ('did:plc:b', 1)")
            state.storage.sql.exec("DELETE FROM holder_state")
            state.storage.sql.exec("DELETE FROM meta WHERE k = 'holder_seeded'")
        })
        await evictDurableObject(stub)
        const states = await runInDurableObject(stub, async (obj: MonitorIngest) => ({
            a: await obj.holderStateOf("did:plc:a"),
            b: await obj.holderStateOf("did:plc:b"),
            none: await obj.holderStateOf("did:plc:none"),
        }))
        expect(states).toEqual({ a: "held", b: "gone-permanent", none: null })
        expect(await rows(stub, "SELECT did FROM records")).toEqual([])
    })

    it("a second constructor run does not change holder state", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), verified())
            await obj.completeDeletion(DID, Date.now(), false)
        })
        await evictDurableObject(stub)
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.holderStateOf(DID))).toBe(
            "gone-reversible"
        )
    })

    it("completeQuietly asserts held", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), verified())
            await obj.completeDeletion(DID, Date.now(), false)
            await obj.completeQuietly(DID, "3m2", Date.now(), verified())
        })
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.holderStateOf(DID))).toBe("held")
    })

    it("a reversible already-gone answer re-asserts gone-reversible", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), verified())
            await obj.completeDeletion(DID, Date.now(), false)
            await obj.completeDeletion(DID, Date.now(), false)
        })
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.holderStateOf(DID))).toBe(
            "gone-reversible"
        )
    })

    it("held_at restarts on a transition into held, not on every write while held", async () => {
        const stub = freshStub()
        const heldAt = () => rows<{ held_at: number }>(stub, "SELECT held_at FROM holder_state")
        await runInDurableObject(stub, (obj: MonitorIngest) => obj.complete(DID, "3m1", 1_000, verified()))
        await runInDurableObject(stub, (obj: MonitorIngest) => obj.complete(DID, "3m2", 2_000, verified()))
        expect(await heldAt()).toEqual([{ held_at: 1_000 }])
        await runInDurableObject(stub, (obj: MonitorIngest) => obj.completeDeletion(DID, 3_000, false))
        await runInDurableObject(stub, (obj: MonitorIngest) => obj.completeQuietly(DID, "3m3", 5_000, verified()))
        expect(await heldAt()).toEqual([{ held_at: 5_000 }])
    })

    it("a seeded held DID that refresh finds gone becomes gone-reversible, quietly; a deleted one stays permanent", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, (_obj, state) => {
            state.storage.sql.exec("INSERT INTO revs (did, rev, observed_at) VALUES ('did:plc:a', '3m1', 1), ('did:plc:b', '3m1', 1)")
            state.storage.sql.exec("INSERT INTO deleted (did, deleted_at) VALUES ('did:plc:b', 1)")
            state.storage.sql.exec("DELETE FROM holder_state")
            state.storage.sql.exec("DELETE FROM meta WHERE k = 'holder_seeded'")
        })
        await evictDurableObject(stub)
        const out = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.markGoneReversible("did:plc:a")
            await obj.markGoneReversible("did:plc:b")
            return {
                a: await obj.holderStateOf("did:plc:a"),
                b: await obj.holderStateOf("did:plc:b"),
                window: await obj.windowMembers(0),
            }
        })
        expect(out).toEqual({ a: "gone-reversible", b: "gone-permanent", window: [] })
    })

    it("deleting the declaration leaves the DID's other collections' records", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), verified())
        })
        await runInDurableObject(stub, (_obj, state) => {
            state.storage.sql.exec(
                "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) VALUES (?, 'app.bsky.actor.profile', 'self', '3m1', 'c', 'k')",
                DID
            )
        })
        await runInDurableObject(stub, (obj: MonitorIngest) =>
            obj.completeDeletion(DID, Date.now(), false)
        )
        expect(
            (await runInDurableObject(stub, (o: MonitorIngest) => o.recordsOf(DID))).map(
                (r) => r.collection
            )
        ).toEqual(["app.bsky.actor.profile"])
    })

    it("a permanent answer for a deleted DID stays gone-permanent", async () => {
        const stub = freshStub()
        await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.complete(DID, "3m1", Date.now(), verified())
            await obj.completeDeletion(DID, Date.now(), true)
            await obj.completeDeletion(DID, Date.now(), false)
        })
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.holderStateOf(DID))).toBe(
            "gone-permanent"
        )
        expect(await runInDurableObject(stub, (o: MonitorIngest) => o.isDeleted(DID))).toBe(true)
    })
})
