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
    mightHaveChanged,
    sealDueWindows,
    intakePlcEvent,
    settleDue,
    sweepBackfill,
    FETCH_AS_OF_SKEW_MS,
    type FetchedRecord,
    type IngestDeps,
} from "@germ-network/atproto-pmr-monitor"
import { kvMonitorRegistrationStore } from "../src/registration-store"
import { DIGEST_MARKER_KEY, kvDeclarationSnapshots, kvSnapshotStore } from "../src/snapshot-store"
import { canonicalDidDocumentJson, kvDidDocuments } from "../src/did-document-store"
import { needsRearm } from "../src/ingest-object"
import type { MonitorIngest } from "../src/ingest-object"
import type { MonitorEnv } from "../src/env"

const testEnv = env as unknown as MonitorEnv
const DID = "did:plc:alice"
const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

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
function withFetch(
    stub: DurableObjectStub<MonitorIngest>,
    fetchRecord: (did: string) => Promise<FetchedRecord>
) {
    return runInDurableObject(stub, async (obj: MonitorIngest) => {
        ;(obj as unknown as { fetchRecord: typeof fetchRecord }).fetchRecord = fetchRecord
        return settleDue({
            index: obj,
            snapshot: kvSnapshotStore(testEnv),
            fetchRecord,
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
            await obj.complete(DID, "3m1", Date.now())
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
            await obj.complete(DID, "3m1", Date.now())
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
            await obj.complete(DID, "3m1", Date.now())
            await obj.completeDeletion(DID, Date.now(), true)
            return obj.revOf(DID)
        })
        expect(untouched).toBe("3m1")
    })

    it("a later complete() (resurrection) clears a prior completeDeletion mark", async () => {
        const stub = freshStub()
        const isDeleted = await runInDurableObject(stub, async (obj: MonitorIngest) => {
            await obj.completeDeletion(DID, Date.now(), true)
            await obj.complete(DID, "3m9", Date.now())
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
            await obj.complete(DID, "3m1", Date.now())
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
            await obj.complete(DID, "3m1", observedAtMs)
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
            await obj.complete("did:plc:old", "3m1", currentWindow - 2 * 600_000)
            await obj.complete("did:plc:now", "3m2", now)
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
            await obj.complete(DID, "3m1", t)
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
            obj.complete(DID, "3m1", Date.now())
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
            fetchRecord: (did: string) => Promise<FetchedRecord>
        ) {
            return runInDurableObject(stub, async (obj: MonitorIngest) => {
                const realDeps = (obj as unknown as { deps(): IngestDeps }).deps()
                return settleDue({ ...realDeps, fetchRecord })
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
                obj.complete(did, "3m9", Date.now())
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
                obj.complete(did, "3m1", Date.now())
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
                fetchRecord: (did: string) => Promise<FetchedRecord>
                fetchHeadRev: (did: string) => Promise<string>
                windowMembers: (w: number) => Promise<string[]>
            }
            o.fetchRecord = async (did) => {
                log.push(`fetchRecord ${did}`)
                return { rev: "3m2", car: new Uint8Array([1]), source: PDS, signingKey: SIGNING_KEY }
            }
            o.fetchHeadRev = async (did) => {
                log.push(`fetchHeadRev ${did}`)
                return "3m1"
            }
            const windowMembers = obj.windowMembers.bind(obj)
            o.windowMembers = async (w) => {
                log.push("seal")
                return windowMembers(w)
            }
            await obj.complete("did:plc:refresh-b", "3m1", old)
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
            await obj.complete("did:plc:r1", "3m1", 1_000)
            await obj.complete("did:plc:r2", "3m1", 2_000)
            await obj.complete("did:plc:r3", "3m1", 3_000)
            await obj.complete("did:plc:r-deleted", "3m1", 100)
            await obj.completeDeletion("did:plc:r-deleted", 200, true)
            await obj.complete("did:plc:r-pending", "3m1", 100)
            await obj.owe("did:plc:r-pending", "3m2")
            await obj.complete("did:plc:r-fresh", "3m1", 90_000)

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
            // A failed attempt keeps the DID due but queues it behind the rest.
            await obj.markAttempted("did:plc:r2", 40_000)
            expect(await obj.dueRefresh(50_000, 1)).toEqual(["did:plc:r3"])
            expect(await obj.dueRefresh(50_000, 10)).toEqual(["did:plc:r3", "did:plc:r2"])
            // Quiet completion advances the rev without a digest-window entry.
            await obj.completeQuietly("did:plc:r2", "3m9", 1_300_000)
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
                (obj as unknown as { fetchHeadRev(did: string): Promise<string> }).fetchHeadRev(did)
            )
            expect(rev).toBe("3m5")
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
                fetchHeadRev: (did: string) => Promise<string>
            }
            o.fetchHeadRev = async (did) => {
                log.push(`refresh ${did}`)
                return "3m1"
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
            await obj.complete("did:plc:s10alarm", "3m1", Date.now() - 3 * 3_600_000)
            await kvSnapshotStore(testEnv).putRecord("did:plc:s10alarm", {
                rev: "3m1",
                car: new Uint8Array([7]),
                observedAtMs: Date.now() - 3 * 3_600_000,
                source: PDS,
                signingKey: SIGNING_KEY,
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

    it("the alarm publishes documents after the refresh pass, and a publish failure does not skip sealing", async () => {
        const ok = await alarmWith(async () => ({ published: 0, remaining: 0, coveredThroughMs: null }))
        const refresh = ok.indexOf("refresh did:plc:s10alarm")
        expect(refresh).toBeGreaterThanOrEqual(0)
        expect(ok).toContain("publish 64")
        expect(ok.indexOf("publish 64")).toBeGreaterThan(refresh)
        expect(ok.indexOf("seal")).toBeGreaterThan(ok.indexOf("publish 64"))

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

    it("isWatched: a DID in revs (deleted included), or only pending, is watched; an unknown DID is not", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:s11rev", "3m1", 1_000)
            await obj.completeDeletion("did:plc:s11del", 1_000, true)
            await obj.intake({ did: "did:plc:s11pend", rev: "3m1" }, "1")
            expect(await obj.isWatched("did:plc:s11rev")).toBe(true)
            expect(await obj.isWatched("did:plc:s11pend")).toBe(true)
            expect(await obj.isWatched("did:plc:s11unknown")).toBe(false)
        })
    })

    it("a permanently deleted DID is still watched, so a recovery operation is seen", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            await obj.complete("did:plc:s11gone", "3m1", 1_000)
            await obj.completeDeletion("did:plc:s11gone", 2_000, true)
            expect(await obj.isDeleted("did:plc:s11gone")).toBe(true)
            expect(await obj.isWatched("did:plc:s11gone")).toBe(true)
            await obj.completeDeletion("did:plc:s11neverindexed", 2_000, true)
            expect(await obj.isWatched("did:plc:s11neverindexed")).toBe(true)
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
        expect(await inMonitorObj(stub, (obj) => obj.readPlcCursor(URL_A))).toBe(2)
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

    it("readPlcCursor answers null when the stored cursor was for another URL", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(4, 4_000)
            await obj.persistPlcCursor()
        })
        expect(await inMonitorObj(stub, (obj) => obj.readPlcCursor(URL_A))).toBe(4)
        expect(await inMonitorObj(stub, (obj) => obj.readPlcCursor(URL_B))).toBeNull()
        const fresh = freshStub()
        expect(await inMonitorObj(fresh, (obj) => obj.readPlcCursor(URL_A))).toBeNull()
    })

    it("resetPlcCursor clears the stored row and the in-memory seq, so a later flush cannot restore it", async () => {
        const stub = freshStub()
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.advancePlcCursor(7, 7_000)
            await obj.persistPlcCursor()
            expect(await obj.readPlcCursor(URL_A)).toBe(7)
            await obj.resetPlcCursor()
            expect((await obj.publishDidDocuments(1)).coveredThroughMs).toBeNull()
            await obj.persistPlcCursor()
            expect(await obj.readPlcCursor(URL_A)).toBeNull()
            await obj.advancePlcCursor(1, 9_000)
            expect(await obj.readPlcCursor(URL_A)).toBe(1)
        })
        expect(await cursorRow(stub)).toMatchObject({ seq: 1, continuousSinceMs: 9_000 })
    })

    it("intakePlcEvent through the real object stores a watched DID's render and ignores an unwatched DID", async () => {
        const stub = freshStub()
        const watched = "did:plc:s11watched"
        const unwatched = "did:plc:s11unwatched"
        const document: DidDocument = { id: watched }
        await inMonitorObj(stub, async (obj) => {
            withUrl(obj, URL_A)
            await obj.complete(watched, "3m1", 1_000)
            const deps = { index: obj, didDocuments: obj }
            expect(
                await intakePlcEvent(deps, {
                    seq: 10,
                    did: unwatched,
                    createdAtMs: 5_000,
                    change: { kind: "render", document: { id: unwatched } },
                })
            ).toBe("ignored")
            expect(
                await intakePlcEvent(deps, {
                    seq: 11,
                    did: watched,
                    createdAtMs: 6_000,
                    change: { kind: "render", document },
                })
            ).toBe("stored")
            await obj.persistPlcCursor()
        })
        expect(await cursorRow(stub)).toMatchObject({ seq: 11 })
        const rows = await runInDurableObject(stub, (_obj, state) => ({
            docs: state.storage.sql
                .exec<{ did: string }>("SELECT did FROM did_documents")
                .toArray()
                .map((r) => r.did),
            pending: state.storage.sql
                .exec<{ did: string; rev: string }>("SELECT did, rev FROM pending")
                .toArray(),
        }))
        expect(rows.docs).toEqual([watched])
        expect(rows.pending).toEqual([{ did: watched, rev: "3m1" }])
    })
})

describe("PLC stream coverage", () => {
    it.todo("no coverage is published before a run's cursor row is persisted")
    it.todo("a drained publish advances coveredThroughMs to the value given, and kvPlcCoverage reads it")
    it.todo("a null coveredThroughMs re-publishes the previous value")
    it.todo("a cursor reset starts a new run at the next frame's createdAt")
    it.todo("a resume from a stored cursor keeps the run's continuousSinceMs")
    it.todo("a changed PLC_EXPORT_STREAM_URL starts a new run")
    it.todo("kvPlcCoverage reads a missing or malformed entry as null")
})

describe("PLC export consumer", () => {
    it.todo("connectPlc is a no-op when PLC_EXPORT_STREAM_URL is unset")
    it.todo("connectPlc sends the stored seq as the cursor parameter, and none when there is no cursor for this URL")
    it.todo("a failed PLC connect does not skip the rest of the alarm")
    it.todo("the alarm persists the PLC cursor before publishing coverage and before sealing")
})
