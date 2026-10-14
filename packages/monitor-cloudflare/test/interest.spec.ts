/**
 * The allow list in the real Durable Object: who is in interest under each
 * policy, how registrations reach it, and what joining and leaving do to
 * everything kept for a DID.
 */
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { intakePlcEvent, settle, type PlcExportEvent } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"
import { kvSnapshotStore } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv & {
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
const VERIFIED = { cid: "bafyreistub", verifiedWith: "zKey" }

let n = 0
const stubOf = (ns: DurableObjectNamespace<MonitorIngest>) => {
    n += 1
    return ns.get(ns.idFromName(`interest-${n}`))
}
const everyoneStub = () => stubOf(testEnv.ingest)
const registeredStub = () => stubOf(testEnv.ingestRegistered)
const inObj = <R>(stub: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(stub, (obj) => fn(obj as MonitorIngest))

/** Forget everything the constructor seeded, as if the object predates the allow list. */
const unseed = (stub: DurableObjectStub<MonitorIngest>) =>
    runInDurableObject(stub, (_obj, state) => {
        state.storage.sql.exec("DELETE FROM interest")
        state.storage.sql.exec("DELETE FROM interest_transitions")
        state.storage.sql.exec("DELETE FROM meta WHERE k = 'interest_seeded'")
    })

describe("interest set and policy", () => {
    it("registered policy: a registered DID is in interest", async () => {
        await inObj(registeredStub(), async (obj) => {
            expect(await obj.inInterest("did:plc:a")).toBe(false)
            await obj.setRegistered("did:plc:a", true, 1)
            expect(await obj.inInterest("did:plc:a")).toBe(true)
            expect(await obj.isRegistered("did:plc:a")).toBe(true)
            expect(await obj.isGraphOwner("did:plc:a")).toBe(true)
            expect(await obj.inInterest("did:plc:other")).toBe(false)
        })
    })

    it("registered policy: a followee of a registered user is in interest; losing its last owner follower leaves", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setOwnerFollowers("did:plc:f", 2, 1)
            expect(await obj.inInterest("did:plc:f")).toBe(true)
            await obj.setOwnerFollowers("did:plc:f", 1, 2)
            expect(await obj.inInterest("did:plc:f")).toBe(true)
            await obj.clearTransition("did:plc:f", (await obj.dueTransitions(10))[0]!.epoch)
            await obj.setOwnerFollowers("did:plc:f", 0, 3)
            expect(await obj.inInterest("did:plc:f")).toBe(false)
            expect(await obj.dueTransitions(10)).toEqual([{ did: "did:plc:f", change: "leave", epoch: 2 }])
        })
    })

    it("everyone policy: held holders are in interest, gone ones are not", async () => {
        await inObj(everyoneStub(), async (obj) => {
            await obj.complete("did:plc:held", "3m1", 1_000, VERIFIED)
            await obj.complete("did:plc:soft", "3m1", 1_000, VERIFIED)
            await obj.completeDeletion("did:plc:soft", 2_000, false)
            await obj.complete("did:plc:hard", "3m1", 1_000, VERIFIED)
            await obj.completeDeletion("did:plc:hard", 2_000, true)
            expect(await obj.inInterest("did:plc:held")).toBe(true)
            expect(await obj.inInterest("did:plc:soft")).toBe(false)
            expect(await obj.inInterest("did:plc:hard")).toBe(false)
            expect(await obj.isGraphOwner("did:plc:held")).toBe(true)
            expect(await obj.isGraphOwner("did:plc:soft")).toBe(false)
            expect(await obj.isWatched("did:plc:held")).toBe(true)
            expect(await obj.isWatched("did:plc:soft")).toBe(false)
            await obj.setRegistered("did:plc:reg", true, 1)
            expect(await obj.inInterest("did:plc:reg")).toBe(true)
        })
    })

    it("join and leave transitions are reported once", async () => {
        await inObj(everyoneStub(), async (obj) => {
            await obj.complete("did:plc:a", "3m1", 1_000, VERIFIED)
            await obj.complete("did:plc:a", "3m2", 2_000, VERIFIED)
            const joins = await obj.dueTransitions(10)
            expect(joins).toEqual([{ did: "did:plc:a", change: "join", epoch: 1 }])
            await obj.clearTransition("did:plc:a", 1)
            expect(await obj.dueTransitions(10)).toEqual([])

            await obj.completeDeletion("did:plc:a", 3_000, false)
            expect(await obj.dueTransitions(10)).toEqual([{ did: "did:plc:a", change: "leave", epoch: 2 }])
            // A clear for an epoch the DID has moved past leaves the queue alone.
            await obj.clearTransition("did:plc:a", 1)
            expect(await obj.dueTransitions(10)).toHaveLength(1)
            await obj.clearTransition("did:plc:a", 2)
            expect(await obj.dueTransitions(10)).toEqual([])
            expect(await obj.interestEpoch("did:plc:a")).toBe(2)
            expect(await obj.interestEpoch("did:plc:never")).toBe(0)
        })
    })

    it("a leave then a join before the alarm leaves only the join queued", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            await obj.clearTransition("did:plc:a", 1)
            await obj.setRegistered("did:plc:a", false, 2)
            await obj.setRegistered("did:plc:a", true, 3)
            expect(await obj.dueTransitions(10)).toEqual([
                { did: "did:plc:a", change: "join", epoch: 3 },
            ])
            expect(await obj.inInterest("did:plc:a")).toBe(true)
            expect(await obj.interestEpoch("did:plc:a")).toBe(3)
        })
    })

    it("a join then a leave before the alarm leaves only the leave queued", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:plc:a", true, 1)
            await obj.setRegistered("did:plc:a", false, 2)
            expect(await obj.dueTransitions(10)).toEqual([
                { did: "did:plc:a", change: "leave", epoch: 2 },
            ])
        })
    })

    it("a non-holder followee is watched", async () => {
        await inObj(registeredStub(), async (obj) => {
            expect(await obj.isWatched("did:plc:f")).toBe(false)
            await obj.setOwnerFollowers("did:plc:f", 1, 1)
            expect(await obj.holderStateOf("did:plc:f")).toBeNull()
            expect(await obj.isWatched("did:plc:f")).toBe(true)
        })
    })

    it("an owed-only never-held DID is watched under both policies", async () => {
        for (const stub of [everyoneStub(), registeredStub()]) {
            await inObj(stub, async (obj) => {
                expect(await obj.isWatched("did:plc:owed")).toBe(false)
                await obj.owe("did:plc:owed", "3m1")
                expect(await obj.inInterest("did:plc:owed")).toBe(false)
                expect(await obj.isWatched("did:plc:owed")).toBe(true)
            })
        }
    })

    it("a deleted DID in interest is not watched", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered("did:plc:d", true, 1)
            await obj.completeDeletion("did:plc:d", 2, true)
            expect(await obj.inInterest("did:plc:d")).toBe(true)
            expect(await obj.isDeleted("did:plc:d")).toBe(true)
            expect(await obj.isWatched("did:plc:d")).toBe(false)
        })
    })

    it("upgrade under everyone seeds interest from held holders", async () => {
        const stub = everyoneStub()
        await inObj(stub, async (obj) => {
            await obj.complete("did:plc:held", "3m1", 1_000, VERIFIED)
            await obj.complete("did:plc:soft", "3m1", 1_000, VERIFIED)
            await obj.completeDeletion("did:plc:soft", 2_000, false)
        })
        await unseed(stub)
        await evictDurableObject(stub)
        await inObj(stub, async (obj) => {
            expect(await obj.inInterest("did:plc:held")).toBe(true)
            expect(await obj.inInterest("did:plc:soft")).toBe(false)
            expect(await obj.dueTransitions(10)).toEqual([
                { did: "did:plc:held", change: "join", epoch: 1 },
            ])
        })
    })

    it("upgrade under everyone marks gone-reversible holders' documents stale", async () => {
        const stub = everyoneStub()
        await inObj(stub, async (obj) => {
            await obj.complete("did:plc:soft", "3m1", 1_000, VERIFIED)
            await obj.recordDidDocument("did:plc:soft", { id: "did:plc:soft" }, Date.now() - 10_000)
            await obj.completeDeletion("did:plc:soft", 2_000, false)
        })
        const docRow = () =>
            runInDurableObject(stub, (_o, state) =>
                state.storage.sql
                    .exec<{ confirmed_at: number; version: number }>(
                        "SELECT confirmed_at, version FROM did_documents WHERE did = 'did:plc:soft'"
                    )
                    .toArray()[0]
            )
        const before = await docRow()
        expect(before!.confirmed_at).toBeGreaterThan(0)
        await unseed(stub)
        await evictDurableObject(stub)
        await inObj(stub, async () => {})
        const after = await docRow()
        expect(after!.confirmed_at).toBe(0)
        expect(after!.version).toBe(before!.version + 1)
    })

    it.todo("upgrade under registered leaves DIDs outside interest only after the first complete reconcile")

    it("after upgrade under everyone, a PLC rotation for a held DID before the first alarm is followed", async () => {
        const stub = everyoneStub()
        await inObj(stub, (obj) => obj.complete("did:plc:held", "3m1", 1_000, VERIFIED))
        await unseed(stub)
        await evictDurableObject(stub)
        await inObj(stub, async (obj) => {
            const event: PlcExportEvent = {
                seq: 5,
                did: "did:plc:held",
                createdAtMs: 5_000,
                update: { kind: "put", key: "zNew", asOfMs: 5_000 },
                change: { kind: "render", document: { id: "did:plc:held" } },
            }
            expect(await intakePlcEvent(obj, event, obj)).toBe("owed")
        })
    })

    it("under registered, a DID with a revs or records row stays watched until its leave is applied", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.complete("did:plc:old", "3m1", 1_000, VERIFIED)
            expect(await obj.inInterest("did:plc:old")).toBe(false)
            expect(await obj.isWatched("did:plc:old")).toBe(true)
        })
    })

    it("a holder discovered under everyone keeps its stored document", async () => {
        const did = "did:plc:found"
        const stub = everyoneStub()
        await inObj(stub, async (obj) => {
            await obj.owe(did, "3m1")
            const outcome = await settle(
                {
                    index: obj,
                    snapshot: kvSnapshotStore(testEnv),
                    didDocuments: obj,
                    fetchRecord: async () => ({
                        car: new Uint8Array([1]),
                        source: "https://pds.example",
                        signingKey: "zKey",
                        didDocument: { document: { id: did }, fetchedAtMs: Date.now() },
                    }),
                    verify: async (_d, r) => ({
                        kind: "verified",
                        key: r.signingKey!,
                        rev: "3m1",
                        cid: "bafyreistub",
                    }),
                    nowMs: () => Date.now(),
                },
                did
            )
            expect(outcome).toBe("stored")
        })
        const row = await runInDurableObject(stub, (_o, state) =>
            state.storage.sql
                .exec<{ confirmed_at: number }>(
                    `SELECT confirmed_at FROM did_documents WHERE did = '${did}'`
                )
                .toArray()[0]
        )
        expect(row!.confirmed_at).toBeGreaterThan(0)
    })
})

describe("registration RPC and reconcile", () => {
    it.todo("register marks the DID registered and in interest")
    it.todo("unregister clears registered; the DID leaves interest unless still followed by an owner")
    it.todo("reconcile adds a registration the RPC missed and removes a stale one")
    it.todo("unregister followed by register within the grace disposes nothing")
    it.todo("reconcile does not remove a DID registered after the listing began")
    it.todo("reconcile does not remove a DID registered just before the listing")
    it.todo("reconcile does not re-add a just-unregistered DID")
    it.todo("registered policy without pmrDirectory fails at startup")
    it.todo("a reconcile that has never run runs on the first alarm")
    it.todo("a failing reconcile does not stop the settles behind it")
})

describe("joining and leaving interest", () => {
    it.todo("joining owes declaration and secondaries")
    it.todo("leaving disposes all snapshots without a push")
    it.todo("a secondary settle for a DID not in interest stores nothing")
    it.todo("a declaration deletion keeps the profile of a DID still in interest")
    it.todo("leaving withdraws the stored DID document")
    it.todo("a fetch in flight across a leave stores nothing")
    it.todo("a non-holder's join settle is quiet")
    it.todo("a holder's join settle is quiet unless a real commit coalesced into it")
    it.todo("leaving under registered drops the deleted row so the document stops being followed")
    it.todo("a reactivation owed between a gone settle and its leave is still settled (everyone)")
    it.todo("a join settle that finds the declaration gone records gone-reversible without a window entry or onDelete")
    it.todo("a leave then a join before the alarm disposes nothing")
    it.todo("a quiet join settle with a permanent not-found writes deleted with no push")
})

describe("head checks follow interest", () => {
    it.todo("a non-holder followee's profile is head-checked")
    it.todo("a non-holder is due once per REFRESH_NONHOLDER_STALE_AFTER_MS, a holder once per REFRESH_STALE_AFTER_MS")
    it.todo("a reversibly gone holder stays due for refresh under everyone")
    it.todo("a failing non-holder is retried once per its own daily bound")
    it.todo("a reversibly gone non-holder keeps the daily cadence")
})

describe("declaration intake by policy", () => {
    it.todo("registered policy ignores declaration commits outside interest")
    it.todo("registered policy skips the relay backfill")
    it.todo("everyone policy discovers new holders")
    it.todo("ignored declaration events advance the persisted cursor at most once per interval, never lowering it")
})
