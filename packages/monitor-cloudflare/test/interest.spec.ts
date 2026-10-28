/**
 * The allow list in the real Durable Object: who is in interest under each
 * policy, how registrations reach it, and what joining and leaving do to
 * everything kept for a DID.
 */
import { readSecondary } from "./secondary-read"
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    applyInterestTransitions,
    intakeSecondary,
    intakePlcEvent,
    refreshDue,
    settle,
    settleDeletion,
    settleDue,
    settleSecondaryDue,
    type CommitEvent,
    type FetchedRecord,
    type IngestDeps,
    type PlcExportEvent,
    type RecordRef,
    type SecondaryDeps,
    type VerifyOutcome,
} from "@germ-network/atproto-pmr-monitor"
import { monitorCollections, type MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"
import { RegisteredMonitorIngest } from "./worker"
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
/** One alarm with the network stubbed out; the connect stages fail, the rest runs. */
async function alarm(stub: DurableObjectStub<MonitorIngest>) {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch
    try {
        await runDurableObjectAlarm(stub)
    } catch {
        // connect() has no real socket to open here.
    } finally {
        globalThis.fetch = original
    }
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
                    interest: obj,
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

/** The directory KV's `list`, paged two at a time, with a hook per page. */
function directory(names: string[], onPage: (page: number) => Promise<void> = async () => {}) {
    let page = 0
    return {
        list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
            const all = names.filter((k) => k.startsWith(prefix ?? ""))
            const from = cursor === undefined ? 0 : Number(cursor)
            await onPage(page++)
            const keys = all.slice(from, from + 2).map((name) => ({ name }))
            const done = from + 2 >= all.length
            return { keys, list_complete: done, cursor: done ? undefined : String(from + 2) }
        },
    } as unknown as KVNamespace
}

type Reg = {
    applyExpiredUnregisters(nowMs: number): Promise<void>
    reconcileRegistrations(nowMs: number): Promise<void>
    queueRegisteredLeaves(): void
}
const reg = (obj: MonitorIngest) => obj as unknown as Reg
const withDirectory = (obj: MonitorIngest, dir: KVNamespace | undefined) => {
    obj.env = { ...obj.env, pmrDirectory: dir }
}
const FAR = () => Date.now() + 3_600_000

describe("registration RPC and reconcile", () => {
    it("register marks the DID registered and in interest", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:a")
            expect(await obj.isRegistered("did:plc:a")).toBe(true)
            expect(await obj.inInterest("did:plc:a")).toBe(true)
            expect(await obj.dueTransitions(10)).toEqual([{ did: "did:plc:a", change: "join", epoch: 1 }])
        })
    })

    it("unregister clears registered; the DID leaves interest unless still followed by an owner", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:a")
            await obj.register("did:plc:b")
            await obj.setOwnerFollowers("did:plc:b", 1, 1)
            await obj.unregister("did:plc:a")
            await obj.unregister("did:plc:b")
            // Nothing happens until the grace has passed.
            await reg(obj).applyExpiredUnregisters(Date.now())
            expect(await obj.isRegistered("did:plc:a")).toBe(true)
            await reg(obj).applyExpiredUnregisters(FAR())
            expect(await obj.isRegistered("did:plc:a")).toBe(false)
            expect(await obj.inInterest("did:plc:a")).toBe(false)
            expect(await obj.isRegistered("did:plc:b")).toBe(false)
            expect(await obj.inInterest("did:plc:b")).toBe(true)
        })
    })

    it("reconcile adds a registration the RPC missed and removes a stale one", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:stale")
            await obj.register("did:plc:kept")
            withDirectory(obj, directory(["did:plc:missed", "did:plc:kept", "did:plc:other", "other:key"]))
            await reg(obj).reconcileRegistrations(FAR())
            expect(await obj.isRegistered("did:plc:missed")).toBe(true)
            expect(await obj.isRegistered("did:plc:other")).toBe(true)
            expect(await obj.isRegistered("did:plc:kept")).toBe(true)
            expect(await obj.isRegistered("did:plc:stale")).toBe(false)
            expect(await obj.isRegistered("other:key")).toBe(false)
        })
    })

    it("unregister followed by register within the grace disposes nothing", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:a")
            await obj.clearTransition("did:plc:a", 1)
            await obj.unregister("did:plc:a")
            await obj.register("did:plc:a")
            await reg(obj).applyExpiredUnregisters(FAR())
            expect(await obj.isRegistered("did:plc:a")).toBe(true)
            expect(await obj.dueTransitions(10)).toEqual([])
            expect(await obj.interestEpoch("did:plc:a")).toBe(1)
        })
    })

    it("reconcile does not remove a DID registered after the listing began", async () => {
        await inObj(registeredStub(), async (obj) => {
            withDirectory(
                obj,
                directory(["did:plc:x", "did:plc:y", "did:plc:z"], async (page) => {
                    if (page === 1) await obj.register("did:plc:late")
                })
            )
            await reg(obj).reconcileRegistrations(Date.now())
            expect(await obj.isRegistered("did:plc:late")).toBe(true)
            expect(await obj.isRegistered("did:plc:z")).toBe(true)
        })
    })

    it("reconcile does not remove a DID registered just before the listing", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:recent")
            withDirectory(obj, directory([]))
            await reg(obj).reconcileRegistrations(Date.now() + 1_000)
            expect(await obj.isRegistered("did:plc:recent")).toBe(true)
        })
    })

    it("reconcile does not re-add a just-unregistered DID", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:gone")
            await obj.unregister("did:plc:gone")
            await reg(obj).applyExpiredUnregisters(FAR())
            await obj.register("did:plc:pending")
            await obj.unregister("did:plc:pending")
            withDirectory(obj, directory(["did:plc:gone", "did:plc:pending"]))
            await reg(obj).reconcileRegistrations(Date.now() + 1_000)
            expect(await obj.isRegistered("did:plc:gone")).toBe(false)
            // A pending unregister is neither cancelled nor pre-empted.
            expect(await obj.isRegistered("did:plc:pending")).toBe(true)
            await reg(obj).applyExpiredUnregisters(FAR())
            expect(await obj.isRegistered("did:plc:pending")).toBe(false)
        })
    })

    it("a failing listing removes nothing and is retried", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:a")
            withDirectory(
                obj,
                directory(["did:plc:x", "did:plc:y", "did:plc:z"], async (page) => {
                    if (page === 1) throw new Error("kv down")
                })
            )
            await expect(reg(obj).reconcileRegistrations(FAR())).rejects.toThrow("kv down")
            expect(await obj.isRegistered("did:plc:a")).toBe(true)
            // Not recorded as done, so the next alarm tries again.
            withDirectory(obj, directory([]))
            await reg(obj).reconcileRegistrations(FAR())
            expect(await obj.isRegistered("did:plc:a")).toBe(false)
        })
    })

    it("registered policy without pmrDirectory fails at startup", async () => {
        await inObj(registeredStub(), async (obj) => {
            withDirectory(obj, undefined)
            expect(() => obj.assertConfig()).toThrow(/pmrDirectory/)
        })
        await inObj(everyoneStub(), async (obj) => {
            withDirectory(obj, undefined)
            expect(() => obj.assertConfig()).not.toThrow()
            await expect(reg(obj).reconcileRegistrations(Date.now())).resolves.toBeUndefined()
        })
    })

    it("reconcile leaves a registration whose unregister is in its grace", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.register("did:plc:replacing")
            await obj.unregister("did:plc:replacing")
            withDirectory(obj, directory([]))
            await reg(obj).reconcileRegistrations(FAR())
            expect(await obj.isRegistered("did:plc:replacing")).toBe(true)
            expect(await obj.dueTransitions(10)).toEqual([
                { did: "did:plc:replacing", change: "join", epoch: 1 },
            ])
        })
    })

    it("an object configured for registered without pmrDirectory refuses to start", async () => {
        await runInDurableObject(registeredStub(), async (_obj, state) => {
            let startup: Promise<unknown> | undefined
            Object.defineProperty(state, "blockConcurrencyWhile", {
                value: (fn: () => Promise<unknown>) => {
                    startup = fn()
                    startup.catch(() => {})
                    return startup
                },
            })
            new RegisteredMonitorIngest(state, { ...testEnv, pmrDirectory: undefined })
            await expect(startup).rejects.toThrow(/pmrDirectory/)
        })
    })

    it("a reconcile that has never run runs on the first alarm", async () => {
        const stub = registeredStub()
        await inObj(stub, async (obj) => {
            withDirectory(obj, directory(["did:plc:listed"]))
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await alarm(stub)
        await inObj(stub, async (obj) => {
            expect(await obj.isRegistered("did:plc:listed")).toBe(true)
            // Done, so a call inside the day lists nothing.
            withDirectory(obj, directory(["did:plc:later"]))
            await reg(obj).reconcileRegistrations(Date.now() + 1_000)
            expect(await obj.isRegistered("did:plc:later")).toBe(false)
            await reg(obj).reconcileRegistrations(FAR() + 86_400_000)
            expect(await obj.isRegistered("did:plc:later")).toBe(true)
        })
    })

    it("a failing reconcile does not stop the settles behind it", async () => {
        const stub = registeredStub()
        const fetched: string[] = []
        await inObj(stub, async (obj) => {
            withDirectory(obj, {
                list: async () => {
                    throw new Error("kv list down")
                },
            } as unknown as KVNamespace)
            ;(obj as unknown as { fetchRecord: (did: string) => Promise<never> }).fetchRecord = async (did) => {
                fetched.push(did)
                throw new RecordNotFoundError("gone", true)
            }
            await obj.owe("did:plc:owed", "3m1")
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await alarm(stub)
        expect(fetched).toEqual(["did:plc:owed"])
    })

    it("upgrade under registered leaves DIDs outside interest only after the first complete reconcile", async () => {
        await inObj(registeredStub(), async (obj) => {
            await obj.complete("did:plc:old", "3m1", 1_000, VERIFIED)
            await obj.complete("did:plc:kept", "3m1", 1_000, VERIFIED)
            await obj.register("did:plc:kept")
            await obj.clearTransition("did:plc:kept", 1)
            reg(obj).queueRegisteredLeaves()
            expect(await obj.dueTransitions(10)).toEqual([])

            withDirectory(obj, {
                list: async () => {
                    throw new Error("down")
                },
            } as unknown as KVNamespace)
            await expect(reg(obj).reconcileRegistrations(FAR())).rejects.toThrow()
            reg(obj).queueRegisteredLeaves()
            expect(await obj.dueTransitions(10)).toEqual([])

            withDirectory(obj, directory(["did:plc:kept"]))
            await reg(obj).reconcileRegistrations(FAR())
            reg(obj).queueRegisteredLeaves()
            expect(await obj.dueTransitions(10)).toEqual([{ did: "did:plc:old", change: "leave", epoch: 1 }])
            // Once only.
            await obj.clearTransition("did:plc:old", 1)
            reg(obj).queueRegisteredLeaves()
            expect(await obj.dueTransitions(10)).toEqual([])
            expect(await obj.isWatched("did:plc:old")).toBe(true)
        })
    })
})

type Internals = {
    fetchRecord: (did: string) => Promise<FetchedRecord>
    verifyRecord: (did: string, record: FetchedRecord) => Promise<VerifyOutcome>
    onChange: (did: string, rev: string) => Promise<void>
    onDelete: (did: string) => Promise<void>
    deps(): IngestDeps
}
const KEY = "zKey"
const PROFILE = "app.bsky.actor.profile"
let d = 0
const uniqDid = () => `did:plc:s2c${(d += 1)}x${crypto.randomUUID().slice(0, 8)}`

/** Swap the authoritative fetch and record the pushes the object would send. */
function drive(obj: MonitorIngest, fetch: (did: string) => Promise<{ rev: string }>) {
    const o = obj as unknown as Internals
    const pushed: string[] = []
    o.fetchRecord = async (did) => {
        const { rev } = await fetch(did)
        return {
            car: new Uint8Array([1]),
            source: "https://pds.example",
            signingKey: KEY,
            didDocument: { document: { id: did }, fetchedAtMs: Date.now() },
            rev,
        } as FetchedRecord
    }
    o.verifyRecord = async (_did, record) => ({
        kind: "verified",
        key: KEY,
        rev: (record as FetchedRecord & { rev: string }).rev,
        cid: "bafyreistub",
    })
    o.onChange = async (did) => void pushed.push(`change ${did}`)
    o.onDelete = async (did) => void pushed.push(`delete ${did}`)
    return { o, pushed }
}

const applyTransitions = (obj: MonitorIngest) =>
    applyInterestTransitions(
        {
            interest: obj,
            index: obj,
            snapshot: kvSnapshotStore(testEnv),
            secondaries: monitorCollections(obj.env),
            didDocuments: obj,
            nowMs: () => Date.now(),
        },
        64
    )
const settleOwed = (obj: MonitorIngest) => settleDue((obj as unknown as Internals).deps(), 32)
const rows = <R extends Record<string, unknown>>(
    stub: DurableObjectStub<MonitorIngest>,
    sql: string
) =>
    runInDurableObject(stub, (_o, state) => state.storage.sql.exec<R>(sql).toArray()) as Promise<R[]>

describe("joining and leaving interest", () => {
    it("joining owes declaration and secondaries", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            expect(await applyTransitions(obj)).toBe(1)
            expect(await obj.dueTransitions(10)).toEqual([])
        })
        expect(await rows(stub, `SELECT did, rev, quiet FROM pending`)).toEqual([{ did, rev: "", quiet: 1 }])
        expect(await rows(stub, `SELECT did, collection, rkey, rev, epoch FROM rec_pending`)).toEqual([
            { did, collection: PROFILE, rkey: "self", rev: "", epoch: 1 },
        ])
    })

    it("a holder already indexed is not re-owed its declaration on joining", async () => {
        const stub = everyoneStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.complete(did, "3m1", 1_000, VERIFIED)
            ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
                "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) VALUES (?, ?, 'self', '3m0', 'c', 'k')",
                did,
                PROFILE
            )
            await applyTransitions(obj)
        })
        expect(await rows(stub, `SELECT did FROM pending`)).toEqual([])
        expect(await rows(stub, `SELECT rev FROM rec_pending`)).toEqual([{ rev: "3m0" }])
    })

    async function withSnapshots(obj: MonitorIngest, did: string) {
        const store = kvSnapshotStore(testEnv)
        const entry = {
            rev: "3m1",
            car: new Uint8Array([7]),
            observedAtMs: 1,
            source: "s",
            signingKey: KEY,
            verifiedWith: KEY,
            cid: "bafyreistub",
        }
        await store.putRecord(did, entry)
        await store.putSecondary({ did, collection: PROFILE, rkey: "self" }, entry)
        await store.putSecondaryCheck({ did, collection: PROFILE, rkey: "self" }, { rev: "3m1", checkedAtMs: 5 })
        await obj.complete(did, "3m1", 1_000, VERIFIED)
        ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
            "INSERT INTO records (did, collection, rkey, rev, cid, verified_with) VALUES (?, ?, 'self', '3m1', 'c', 'k')",
            did,
            PROFILE
        )
    }

    it("leaving disposes all snapshots without a push", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => ({ rev: "3m1" })).pushed
            await obj.setRegistered(did, true, 1)
            await withSnapshots(obj, did)
            await obj.owe(did, "3m2")
            await obj.markChecked(did, 5)
            await obj.oweKeyUpdate(did, { kind: "delete" })
            await applyTransitions(obj) // the join
            await obj.setRegistered(did, false, 2)
            expect(await applyTransitions(obj)).toBe(1)
            const store = kvSnapshotStore(testEnv)
            expect(await store.getRecord(did)).toBeNull()
            expect(await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })).toBeNull()
            expect(await env.records.get(`chk:${PROFILE}/self:${did}`)).toBeNull()
        })
        expect(pushed).toEqual([])
        for (const t of ["records", "rec_pending", "checks", "pending", "revs", "holder_state", "key_updates"]) {
            expect(await rows(stub, `SELECT did FROM ${t} WHERE did = '${did}'`)).toEqual([])
        }
    })

    it("under everyone a leave keeps pending, revs and holder_state", async () => {
        const stub = everyoneStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.complete(did, "3m1", 1_000, VERIFIED)
            await applyTransitions(obj)
            await obj.completeDeletion(did, 2_000, false)
            await obj.owe(did, "3m2")
            await applyTransitions(obj)
        })
        expect(await rows(stub, `SELECT did FROM revs WHERE did = '${did}'`)).toHaveLength(1)
        expect(await rows(stub, `SELECT did FROM pending WHERE did = '${did}'`)).toHaveLength(1)
        expect(await rows(stub, `SELECT state FROM holder_state WHERE did = '${did}'`)).toEqual([
            { state: "gone-reversible" },
        ])
    })

    type SecondaryInternals = {
        secondaryDeps(): SecondaryDeps
        fetchRecordAt: (ref: RecordRef) => Promise<FetchedRecord>
        verifyRecordAt: (ref: RecordRef, record: FetchedRecord) => Promise<VerifyOutcome>
    }
    const driveSecondary = (
        obj: MonitorIngest,
        fetch: (ref: RecordRef) => Promise<{ rev: string }>
    ) => {
        const o = obj as unknown as SecondaryInternals
        o.fetchRecordAt = async (ref) => {
            const { rev } = await fetch(ref)
            return { car: new Uint8Array([5]), source: "https://pds", signingKey: KEY, rev } as FetchedRecord
        }
        o.verifyRecordAt = async (_ref, record) => ({
            kind: "verified",
            key: KEY,
            rev: (record as FetchedRecord & { rev: string }).rev,
            cid: "bafyreiprofile",
        })
        return () => settleSecondaryDue(o.secondaryDeps(), 32)
    }

    it("a secondary settle stores under its own keys and index row, leaving revs and the window alone", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            const settleSecondaries = driveSecondary(obj, async () => ({ rev: "3m4" }))
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            expect(await settleSecondaries()).toBe(1)
            const got = await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })
            expect(got).toMatchObject({ rev: "3m4", verifiedWith: KEY, cid: "bafyreiprofile" })
            expect(await obj.secondaryRevOf({ did, collection: PROFILE, rkey: "self" })).toBe("3m4")
            expect(await obj.revOf(did)).toBeNull()
        })
        expect(await rows(stub, "SELECT did FROM rec_pending")).toEqual([])
        expect(await rows(stub, "SELECT did FROM window_members")).toEqual([])
    })

    it("a secondary settle for a DID not in interest stores nothing", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            const fetches: string[] = []
            const settleSecondaries = driveSecondary(obj, async (ref) => {
                fetches.push(ref.did)
                return { rev: "3m4" }
            })
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await obj.setRegistered(did, false, 2) // left, leave not yet applied
            expect(await settleSecondaries()).toBe(0)
            expect(fetches).toEqual([])
            expect(await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })).toBeNull()
        })
        expect(await rows(stub, "SELECT did FROM rec_pending")).toEqual([])
    })

    it("the secondary index refuses a write for another epoch or an older rev", async () => {
        const did = uniqDid()
        const ref = { did, collection: PROFILE, rkey: "self" }
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            expect(await obj.completeSecondary(ref, "3m5", { cid: "c", verifiedWith: KEY }, 1, "3m5")).toBe("stored")
            expect(await obj.completeSecondary(ref, "3m4", { cid: "c", verifiedWith: KEY }, 1, "3m4")).toBe("older")
            expect(await obj.disposeSecondary(ref, "3m4", 1, "3m4")).toBe("older")
            expect(await obj.completeSecondary(ref, "3m6", { cid: "c", verifiedWith: KEY }, 7, "3m6")).toBe("left")
            expect(await obj.secondaryRevOf(ref)).toBe("3m5")
            await obj.setRegistered(did, false, 2)
            expect(await obj.disposeSecondary(ref, "3m9", 1, "3m9")).toBe("left")
            expect(await obj.secondaryRevOf(ref)).toBe("3m5")
        })
    })

    it("a repo-level answer on the declaration disposes the stored profile; a record-level one does not", async () => {
        for (const reason of ["RepoTakendown", "RecordNotFound"]) {
            const did = uniqDid()
            await inObj(registeredStub(), async (obj) => {
                await obj.setRegistered(did, true, 1)
                await withSnapshots(obj, did)
                const { o } = drive(obj, async () => {
                    throw new RecordNotFoundError("gone", false, reason)
                })
                await settle(o.deps(), did)
                const profile = await readSecondary(testEnv, {
                    did,
                    collection: PROFILE,
                    rkey: "self",
                })
                expect(profile === null).toBe(reason === "RepoTakendown")
                expect((await obj.recordsOf(did)).some((r) => r.collection === PROFILE)).toBe(
                    reason !== "RepoTakendown"
                )
            })
        }
    })

    it("a repo-level answer on a secondary of a held DID owes the declaration loudly", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            const settleSecondaries = driveSecondary(obj, async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            })
            await obj.setRegistered(did, true, 1)
            await obj.complete(did, "3m1", 1_000, VERIFIED)
            await applyTransitions(obj)
            await settleSecondaries()
            expect(await obj.duePending(Date.now(), 10)).toMatchObject([{ did, rev: "3m1", quiet: false }])
        })
    })

    it("the alarm settles owed secondaries after the declarations", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        const log: string[] = []
        await inObj(stub, async (obj) => {
            const o = obj as unknown as SecondaryInternals & Internals
            drive(obj, async (d) => {
                log.push(`declaration ${d}`)
                return { rev: "3m1" }
            })
            o.fetchRecordAt = async (ref) => {
                log.push(`secondary ${ref.did}`)
                return { car: new Uint8Array([5]), source: "s", signingKey: KEY, rev: "3m4" } as FetchedRecord
            }
            o.verifyRecordAt = async (_r, record) => ({
                kind: "verified",
                key: KEY,
                rev: (record as FetchedRecord & { rev: string }).rev,
                cid: "c",
            })
            withDirectory(obj, directory([did]))
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
        })
        await alarm(stub)
        expect(log).toEqual([`declaration ${did}`, `secondary ${did}`])
    })

    it("a repo-level answer on a secondary of a never-held DID is judged quietly by the declaration path", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            }).pushed
            const settleSecondaries = driveSecondary(obj, async () => {
                throw new RecordNotFoundError("repo gone", false, "RepoTakendown")
            })
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            // Drop the join's declaration obligation so only the deferral owes it.
            ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec("DELETE FROM pending")
            const store = kvSnapshotStore(testEnv)
            await store.putSecondary({ did, collection: PROFILE, rkey: "self" }, {
                rev: "3m1",
                car: new Uint8Array([1]),
                observedAtMs: 1,
                source: "s",
                signingKey: KEY,
                verifiedWith: KEY,
                cid: "c",
            })
            await settleSecondaries()
            const [owed] = await obj.duePending(Date.now(), 10)
            expect(owed).toMatchObject({ did, quiet: true })
            await settleOwed(obj)
            expect(await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })).toBeNull()
            expect((await obj.recordsOf(did)).filter((r) => r.collection === PROFILE)).toEqual([])
        })
        expect(pushed).toEqual([])
        expect(await rows(stub, "SELECT did FROM window_members")).toEqual([])
    })

    it("a declaration deletion keeps the profile of a DID still in interest", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await withSnapshots(obj, did)
            await settleDeletion((obj as unknown as Internals).deps(), did, false)
            const store = kvSnapshotStore(testEnv)
            expect(await store.getRecord(did)).toBeNull()
            expect(await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })).not.toBeNull()
            expect((await obj.recordsOf(did)).map((r) => r.collection)).toEqual([PROFILE])
        })
    })

    it("leaving withdraws the stored DID document", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await obj.recordDidDocument(did, { id: did }, Date.now() - 1_000)
            await applyTransitions(obj)
            await obj.setRegistered(did, false, 2)
            await applyTransitions(obj)
        })
        const [row] = await rows<{ confirmed_at: number }>(
            stub,
            `SELECT confirmed_at FROM did_documents WHERE did = '${did}'`
        )
        expect(row!.confirmed_at).toBe(0)
    })

    it("a fetch in flight across a leave stores nothing", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            const { o } = drive(obj, async () => {
                await obj.setRegistered(did, false, 2)
                return { rev: "3m1" }
            })
            const outcome = await settle(o.deps(), did, { quiet: true })
            expect(outcome).toBe("left")
            expect(await kvSnapshotStore(testEnv).getRecord(did)).toBeNull()
            expect(await obj.revOf(did)).toBeNull()
        })
    })

    it("a not-found across a leave stores nothing", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            const { o } = drive(obj, async () => {
                await obj.setRegistered(did, false, 2)
                throw new RecordNotFoundError("gone", true)
            })
            expect(await settle(o.deps(), did, { quiet: true })).toBe("left")
            expect(await obj.isDeleted(did)).toBe(false)
            expect(await obj.holderStateOf(did)).toBeNull()
        })
    })

    it("a real obligation clears the quiet mark of a join's", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            expect((await obj.duePending(Date.now(), 10))[0]!.quiet).toBe(true)
            await obj.owe(did, "3m1")
            expect((await obj.duePending(Date.now(), 10))[0]!.quiet).toBe(false)
        })
    })

    it("a register arriving while a leave disposes does not strand the index ahead of the bytes", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await withSnapshots(obj, did)
            await obj.setRegistered(did, false, 2)
            await applyInterestTransitions(
                {
                    interest: obj,
                    index: obj,
                    snapshot: kvSnapshotStore(testEnv),
                    secondaries: monitorCollections(obj.env),
                    didDocuments: {
                        markDidDocumentStale: async () => {
                            await obj.register(did)
                        },
                    } as never,
                    nowMs: () => Date.now(),
                },
                64
            )
            expect(await obj.revOf(did)).toBeNull()
            expect(await obj.dueTransitions(10)).toEqual([{ did, change: "join", epoch: 3 }])
            await applyTransitions(obj)
            expect((await obj.duePending(Date.now(), 10)).map((p) => p.did)).toEqual([did])
        })
    })

    const windowCount = (stub: DurableObjectStub<MonitorIngest>) =>
        rows<{ n: number }>(stub, "SELECT COUNT(*) AS n FROM window_members").then((r) => r[0]!.n)

    it("a non-holder's join settle is quiet", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => ({ rev: "3m1" })).pushed
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await settleOwed(obj)
            expect(await obj.revOf(did)).toBe("3m1")
            expect(await kvSnapshotStore(testEnv).getRecord(did)).not.toBeNull()
            expect(await obj.holderStateOf(did)).toBe("held")
        })
        expect(pushed).toEqual([])
        expect(await windowCount(stub)).toBe(0)
        expect(await rows(stub, "SELECT did FROM pending")).toEqual([])
    })

    it("a holder's join settle is quiet unless a real commit coalesced into it", async () => {
        for (const coalesced of [false, true]) {
            const stub = everyoneStub()
            const did = uniqDid()
            let pushed: string[] = []
            await inObj(stub, async (obj) => {
                pushed = drive(obj, async () => ({ rev: "3m2" })).pushed
                await obj.complete(did, "3m1", 1_000, VERIFIED)
                await kvSnapshotStore(testEnv).putRecord(did, {
                    rev: "3m1",
                    car: new Uint8Array([1]),
                    observedAtMs: 1,
                    source: "s",
                    signingKey: KEY,
                    verifiedWith: KEY,
                    cid: "bafyreistub",
                })
                ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
                    "DELETE FROM window_members; INSERT INTO pending (did, rev, quiet) VALUES (?, '3m1', 1)",
                    did
                )
                if (coalesced) await obj.intake({ did, rev: "3m2" }, "9")
                await settleOwed(obj)
                expect(await obj.revOf(did)).toBe("3m2")
            })
            expect(pushed).toEqual(coalesced ? [`change ${did}`] : [])
            expect(await windowCount(stub)).toBe(coalesced ? 1 : 0)
        }
    })

    it("leaving under registered drops the deleted row so the document stops being followed", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await obj.complete(did, "3m1", 1_000, VERIFIED)
            await obj.completeDeletion(did, 2_000, true)
            expect(await obj.isDeleted(did)).toBe(true)
            await obj.setRegistered(did, false, 2)
            await applyTransitions(obj)
            await applyTransitions(obj)
            expect(await obj.isDeleted(did)).toBe(false)
            expect(await obj.revOf(did)).toBeNull()
            expect(await obj.isWatched(did)).toBe(false)
        })
    })

    it("a reactivation owed between a gone settle and its leave is still settled (everyone)", async () => {
        const stub = everyoneStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            drive(obj, async () => ({ rev: "3m2" }))
            await obj.complete(did, "3m1", 1_000, VERIFIED)
            await applyTransitions(obj)
            await obj.completeDeletion(did, 2_000, false)
            await obj.owe(did, "3m2")
            await applyTransitions(obj) // the leave
            await settleOwed(obj)
            expect(await obj.revOf(did)).toBe("3m2")
            expect(await obj.inInterest(did)).toBe(true)
        })
    })

    /** A holder that joins interest with a quiet declaration obligation still owed. */
    async function quietOwedHolder(obj: MonitorIngest, did: string) {
        await obj.complete(did, "3m1", 1_000, VERIFIED)
        ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
            "DELETE FROM window_members; INSERT INTO pending (did, rev, quiet) VALUES (?, '3m1', 1)",
            did
        )
    }

    it("a join settle that finds the declaration gone records gone-reversible without a window entry or onDelete", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => {
                throw new RecordNotFoundError("no record", false)
            }).pushed
            await obj.setRegistered(did, true, 1)
            await quietOwedHolder(obj, did)
            await settleOwed(obj)
            expect(await obj.holderStateOf(did)).toBe("gone-reversible")
            expect(await obj.isDeleted(did)).toBe(false)
        })
        expect(pushed).toEqual([])
        expect(await windowCount(stub)).toBe(0)
        expect(await rows(stub, "SELECT did FROM pending")).toEqual([])
    })

    it("a join settle for a DID that never held a declaration records nothing", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            for (const permanent of [false, true]) {
                drive(obj, async () => {
                    throw new RecordNotFoundError("no record", permanent, "RecordNotFound")
                })
                await obj.setRegistered(did, true, 1)
                await applyTransitions(obj)
                await settleOwed(obj)
                expect(await obj.holderStateOf(did)).toBeNull()
                expect(await obj.isDeleted(did)).toBe(false)
                await obj.owe(did, "x") // a real obligation would be settled loudly
                ;(obj as unknown as { db: DurableObjectStorage }).db.sql.exec(
                    "UPDATE pending SET quiet = 1"
                )
                await settleOwed(obj)
                expect(await obj.holderStateOf(did)).toBeNull()
            }
        })
        expect(await rows(stub, "SELECT did FROM pending")).toEqual([])
        expect(await windowCount(stub)).toBe(0)
    })

    it("a leave then a join before the alarm disposes nothing", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await withSnapshots(obj, did)
            await obj.setRegistered(did, false, 2)
            await obj.setRegistered(did, true, 3)
            await applyTransitions(obj)
            const store = kvSnapshotStore(testEnv)
            expect(await store.getRecord(did)).not.toBeNull()
            expect(await readSecondary(testEnv, { did, collection: PROFILE, rkey: "self" })).not.toBeNull()
            expect(await obj.revOf(did)).toBe("3m1")
        })
    })

    it("a quiet join settle with a permanent not-found writes deleted with no push", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => {
                throw new RecordNotFoundError("repo gone", true)
            }).pushed
            await obj.setRegistered(did, true, 1)
            await quietOwedHolder(obj, did)
            await settleOwed(obj)
            expect(await obj.isDeleted(did)).toBe(true)
        })
        expect(pushed).toEqual([])
        expect(await windowCount(stub)).toBe(0)
    })
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe("owed secondary fetch", () => {
    const profileCommit = (did: string, rev: string, rkey = "self", collection = PROFILE): CommitEvent => ({
        kind: "commit",
        did,
        collection,
        rkey,
        operation: "update",
        rev,
        cid: null,
        seq: null,
        timeMs: null,
        subject: null,
    })
    const live = (obj: MonitorIngest, event: CommitEvent, cursor = "9000") =>
        intakeSecondary({ index: obj }, { records: monitorCollections(obj.env) }, event, cursor)
    const pendingOf = (obj: MonitorIngest, did: string) =>
        obj.ctx.storage.sql
            .exec<{ rev: string; epoch: number }>("SELECT rev, epoch FROM rec_pending WHERE did = ?", did)
            .toArray()
    const ref = (did: string) => ({ did, collection: PROFILE, rkey: "self" })

    type SecondaryInternals = {
        secondaryDeps(): SecondaryDeps
        fetchRecordAt: (ref: RecordRef) => Promise<FetchedRecord>
        verifyRecordAt: (ref: RecordRef, record: FetchedRecord) => Promise<VerifyOutcome>
    }
    /** A settle whose fetch runs `during` first, so a live commit can land mid-flight. */
    const settleWith = (
        obj: MonitorIngest,
        fetched: { rev: string } | Error,
        during: () => Promise<void>,
        verify: "verified" | "unverifiable" = "verified"
    ) => {
        const o = obj as unknown as SecondaryInternals
        o.fetchRecordAt = async () => {
            await during()
            if (fetched instanceof Error) throw fetched
            return { car: new Uint8Array([5]), source: "https://pds", signingKey: KEY, rev: fetched.rev } as FetchedRecord
        }
        o.verifyRecordAt = async (_ref, record) =>
            verify === "unverifiable"
                ? { kind: "unverifiable" }
                : { kind: "verified", key: KEY, rev: (record as FetchedRecord & { rev: string }).rev, cid: "bafyreiprofile" }
        return settleSecondaryDue(o.secondaryDeps(), 32)
    }

    it("profile commit for a DID in interest owes a fetch with the cursor", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            expect(await live(obj, profileCommit(did, "3m7"), "9000")).toBe("accepted")
            expect(pendingOf(obj, did)).toEqual([{ rev: "3m7", epoch: await obj.interestEpoch(did) }])
        })
        expect(await rows(stub, "SELECT v FROM meta WHERE k = 'follow_cursor'")).toEqual([{ v: "9000" }])
    })

    it("profile commit at the indexed rev is a duplicate", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await obj.completeSecondary(ref(did), "3m5", VERIFIED, 1, "3m5")
            expect(await live(obj, profileCommit(did, "3m5"))).toBe("duplicate")
            expect(pendingOf(obj, did)).toEqual([])
            expect(await live(obj, profileCommit(did, "3m6"))).toBe("accepted")
        })
    })

    it("profile commit outside interest is ignored", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            expect(await live(obj, profileCommit(did, "3m7"))).toBe("ignored")
            await obj.setRegistered(did, true, 1)
            await obj.setRegistered(did, false, 2)
            expect(await live(obj, profileCommit(did, "3m8"))).toBe("ignored")
            expect(pendingOf(obj, did)).toEqual([])
        })
        expect(await rows(stub, "SELECT v FROM meta WHERE k = 'follow_cursor'")).toEqual([])
    })

    it("a commit on an unwatched rkey is ignored", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            expect(await live(obj, profileCommit(did, "3m7", "other"))).toBe("ignored")
            expect(await live(obj, profileCommit(did, "3m7", "self", "app.bsky.feed.post"))).toBe("ignored")
            expect(pendingOf(obj, did)).toEqual([])
        })
    })

    it("a live owe over a row from an earlier epoch settles at the current epoch", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj) // the join owes the row at epoch 1
            await obj.setRegistered(did, false, 2)
            await obj.setRegistered(did, true, 3) // netted: no transition applied
            expect(pendingOf(obj, did)).toEqual([{ rev: "", epoch: 1 }])
            expect(await live(obj, profileCommit(did, "3m7"))).toBe("accepted")
            expect(pendingOf(obj, did)).toEqual([{ rev: "3m7", epoch: 3 }])
            expect(await settleWith(obj, { rev: "3m7" }, async () => {})).toBe(1)
            expect(await obj.secondaryRevOf(ref(did))).toBe("3m7")
            expect(pendingOf(obj, did)).toEqual([])
        })
    })

    it("a live owe during an in-flight settle survives", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            const settled = await settleWith(obj, { rev: "3m4" }, async () => {
                expect(await live(obj, profileCommit(did, "3m9"))).toBe("accepted")
            })
            expect(settled).toBe(1)
            expect(await obj.secondaryRevOf(ref(did))).toBe("3m4")
            expect(pendingOf(obj, did)).toMatchObject([{ rev: "3m9" }])
            // The surviving owe is then settled on its own.
            expect(await settleWith(obj, { rev: "3m9" }, async () => {})).toBe(1)
            expect(pendingOf(obj, did)).toEqual([])
        })
    })

    it("a live owe during a settle that ends not-found survives", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await settleWith(obj, new RecordNotFoundError("gone", false, "RecordNotFound"), async () => {
                await live(obj, profileCommit(did, "3m9"))
            })
            expect(pendingOf(obj, did)).toMatchObject([{ rev: "3m9" }])
        })
    })

    it("a live owe during a settle that ends unverifiable survives", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await settleWith(obj, { rev: "3m4" }, async () => {
                await live(obj, profileCommit(did, "3m9"))
            }, "unverifiable")
            expect(pendingOf(obj, did)).toMatchObject([{ rev: "3m9" }])
        })
    })

    it("a live owe during a settle that ends older survives", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await obj.completeSecondary(ref(did), "3m8", VERIFIED, 1, "")
            await live(obj, profileCommit(did, "3m2"))
            await settleWith(obj, { rev: "3m4" }, async () => {
                await live(obj, profileCommit(did, "3m9"))
            })
            expect(await obj.secondaryRevOf(ref(did))).toBe("3m8")
            expect(pendingOf(obj, did)).toMatchObject([{ rev: "3m9" }])
        })
    })
})

describe("head checks follow interest", () => {
    const due = (obj: MonitorIngest, now = Date.now()) =>
        obj.dueRefresh(now - HOUR, 50, now - DAY)

    it("a non-holder followee's profile is head-checked", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            const now = Date.now()
            await obj.setOwnerFollowers(did, 1, now - 2 * DAY)
            expect(await due(obj, now)).toEqual([did])
            // Owed a fetch, it is left to that settle.
            await applyTransitions(obj)
            expect(await due(obj, now)).toEqual([])
        })
    })

    it("a non-holder is due once per REFRESH_NONHOLDER_STALE_AFTER_MS, a holder once per REFRESH_STALE_AFTER_MS", async () => {
        await inObj(everyoneStub(), async (obj) => {
            const now = Date.now()
            const holderOld = uniqDid()
            const holderFresh = uniqDid()
            const nonHolderOld = uniqDid()
            const nonHolderFresh = uniqDid()
            await obj.complete(holderOld, "3m1", now - 2 * HOUR, VERIFIED)
            await obj.complete(holderFresh, "3m1", now - HOUR / 2, VERIFIED)
            await obj.setRegistered(nonHolderOld, true, now - 25 * HOUR)
            await obj.setRegistered(nonHolderFresh, true, now - 2 * HOUR)
            expect((await due(obj, now)).sort()).toEqual([holderOld, nonHolderOld].sort())
        })
    })

    it("a reversibly gone holder stays due for refresh under everyone", async () => {
        const did = uniqDid()
        await inObj(everyoneStub(), async (obj) => {
            const now = Date.now()
            await obj.complete(did, "3m1", now - 3 * HOUR, VERIFIED)
            await obj.completeDeletion(did, now - 2 * HOUR, false)
            expect(await obj.inInterest(did)).toBe(false)
            expect(await due(obj, now)).toEqual([did])
            await obj.completeDeletion(did, now - HOUR, true)
            expect(await due(obj, now)).toEqual([])
        })
    })

    it("a reversibly gone holder is not polled under registered", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            const now = Date.now()
            await obj.complete(did, "3m1", now - 3 * HOUR, VERIFIED)
            await obj.completeDeletion(did, now - 2 * HOUR, false)
            expect(await obj.holderStateOf(did)).toBe("gone-reversible")
            expect(await due(obj, now)).toEqual([])
        })
    })

    it("a DID owed a declaration or a secondary is left to that settle, not head-checked", async () => {
        const stub = registeredStub()
        await inObj(stub, async (obj) => {
            const now = Date.now()
            const sql = (obj as unknown as { db: DurableObjectStorage }).db.sql
            const [a, b, c] = [uniqDid(), uniqDid(), uniqDid()]
            for (const did of [a, b, c]) await obj.setOwnerFollowers(did, 1, now - 3 * DAY)
            expect((await due(obj, now)).sort()).toEqual([a, b, c].sort())
            sql.exec("INSERT INTO pending (did, rev) VALUES (?, '')", a)
            expect((await due(obj, now)).sort()).toEqual([b, c].sort())
            sql.exec(
                "INSERT INTO rec_pending (did, collection, rkey, rev) VALUES (?, ?, 'self', '')",
                b,
                PROFILE
            )
            expect(await due(obj, now)).toEqual([c])
        })
    })

    it("a failing non-holder is retried once per its own daily bound", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            const now = Date.now()
            await obj.setOwnerFollowers(did, 1, now - 3 * DAY)
            await obj.markAttempted(did, now - 2 * HOUR)
            expect(await due(obj, now)).toEqual([])
            await obj.markAttempted(did, now - 25 * HOUR)
            expect(await due(obj, now)).toEqual([did])
        })
    })

    it("a reversibly gone non-holder keeps the daily cadence", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setOwnerFollowers(did, 1, Date.now() - 3 * DAY)
            await applyTransitions(obj)
            await (obj as unknown as { db: DurableObjectStorage }).db.sql.exec("DELETE FROM pending; DELETE FROM rec_pending")
            const o = obj as unknown as Internals
            const result = await refreshDue(
                {
                    ingest: o.deps(),
                    refreshIndex: obj,
                    refreshSnapshots: kvSnapshotStore(testEnv),
                    fetchHeadRev: async () => {
                        throw new RecordNotFoundError("suspended", false, "RepoSuspended")
                    },
                    collection: testEnv.MONITOR_COLLECTION,
                    rkey: "self",
                    secondary: { deps: (obj as unknown as SecondaryInternals).secondaryDeps(), records: [] },
                },
                { nowMs: Date.now(), staleAfterMs: HOUR, nonHolderStaleAfterMs: DAY, limit: 10 }
            )
            expect(result.outcomes.deleted).toBe(1)
            expect(await obj.holderStateOf(did)).toBeNull()
            expect(await obj.isDeleted(did)).toBe(false)
            expect(await due(obj)).toEqual([])
            // Due again a day later, on the daily bound, not the hourly one.
            expect(await due(obj, Date.now() + 2 * HOUR)).toEqual([])
            expect(await due(obj, Date.now() + 25 * HOUR)).toEqual([did])
        })
    })
})

const frame = (did: string, rev: string, timeUs: number, collection = testEnv.MONITOR_COLLECTION) =>
    JSON.stringify({
        payload: {
            $type: "com.atproto.sync.subscribeRepos#commit",
            did,
            collection,
            rev,
            rkey: "self",
            operation: "update",
            time_us: timeUs,
        },
    })
const onFrame = (obj: MonitorIngest, raw: string) =>
    (obj as unknown as { onFrame(raw: string): Promise<void> }).onFrame(raw)

describe("declaration intake by policy", () => {
    it("registered policy ignores declaration commits outside interest", async () => {
        const stub = registeredStub()
        const inside = uniqDid()
        const outside = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(inside, true, 1)
            await onFrame(obj, frame(outside, "3m1", 1_000_000))
            await onFrame(obj, frame(inside, "3m1", 2_000_000))
            expect((await obj.duePending(Date.now(), 10)).map((p) => p.did)).toEqual([inside])
        })
    })

    it("registered policy skips the relay backfill", async () => {
        const asked = async (stub: DurableObjectStub<MonitorIngest>) => {
            await inObj(stub, async (obj) => {
                withDirectory(obj, directory([]))
                await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
            })
            const urls: string[] = []
            const original = globalThis.fetch
            globalThis.fetch = ((input: RequestInfo | URL) => {
                urls.push(String(input))
                return Promise.resolve(Response.json({ repos: [] }))
            }) as typeof fetch
            try {
                await runDurableObjectAlarm(stub)
            } catch {
                // connect() has no real socket to open here.
            } finally {
                globalThis.fetch = original
            }
            return urls.filter((u) => u.includes("listReposByCollection"))
        }
        expect(await asked(registeredStub())).toEqual([])
        expect((await asked(everyoneStub())).length).toBeGreaterThan(0)
    })

    it("everyone policy discovers new holders", async () => {
        const did = uniqDid()
        await inObj(everyoneStub(), async (obj) => {
            await onFrame(obj, frame(did, "3m1", 1_000_000))
            expect((await obj.duePending(Date.now(), 10)).map((p) => p.did)).toEqual([did])
        })
    })

    it("ignored declaration events advance the persisted cursor at most once per interval, never lowering it", async () => {
        const stub = registeredStub()
        const outside = uniqDid()
        const cursor = (obj: MonitorIngest) => obj.readCursor()
        let now = 1_000_000
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
        try {
            await inObj(stub, async (obj) => {
                await onFrame(obj, frame(outside, "3m1", 5_000_000))
                expect(await cursor(obj)).toBe("5000000")
                // Inside the interval, a later event does not write.
                now += 1_000
                await onFrame(obj, frame(outside, "3m2", 6_000_000))
                expect(await cursor(obj)).toBe("5000000")
                // After it, the cursor is raised.
                now += 5_000
                await onFrame(obj, frame(outside, "3m3", 7_000_000))
                expect(await cursor(obj)).toBe("7000000")
                // An older event never lowers it.
                now += 6_000
                await onFrame(obj, frame(outside, "3m4", 1_000_000))
                expect(await cursor(obj)).toBe("7000000")
                // Nor does one behind a cursor an accepted event moved ahead.
                await obj.setRegistered(outside, true, 1)
                await onFrame(obj, frame(outside, "3m5", 9_000_000))
                expect(await cursor(obj)).toBe("9000000")
                now += 6_000
                const other = uniqDid()
                await onFrame(obj, frame(other, "3m6", 8_000_000))
                expect(await cursor(obj)).toBe("9000000")
                // Identity events for a DID not followed are ignored events too.
                now += 6_000
                await onFrame(
                    obj,
                    JSON.stringify({
                        payload: { $type: "com.atproto.sync.subscribeRepos#identity", did: other, time_us: 11_000_000 },
                    })
                )
                expect(await cursor(obj)).toBe("11000000")
            })
        } finally {
            clock.mockRestore()
        }
    })
})

describe("documents and key updates follow interest", () => {
    // did:web keeps this independent of whether the PLC stream is configured,
    // which makes the wrapper drop did:plc hints.
    it("an identity event for a non-holder did:web followee owes a key update", async () => {
        const stub = registeredStub()
        const followee = `did:web:followee${crypto.randomUUID().slice(0, 8)}.example`
        const stranger = `did:web:stranger${crypto.randomUUID().slice(0, 8)}.example`
        await inObj(stub, async (obj) => {
            await obj.setOwnerFollowers(followee, 1, 1)
            for (const did of [followee, stranger]) {
                await onFrame(
                    obj,
                    JSON.stringify({
                        payload: { $type: "com.atproto.sync.subscribeRepos#identity", did, time_us: 1_000_000 },
                    })
                )
            }
        })
        expect(await rows(stub, "SELECT did, kind FROM key_updates")).toEqual([{ did: followee, kind: "delete" }])
        expect(await rows(stub, "SELECT did FROM pending")).toEqual([])
    })
    it("a head check for a DID that is not watched records no document (a gone-reversible holder under everyone)", async () => {
        const stub = everyoneStub()
        const did = uniqDid()
        const original = globalThis.fetch
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
                                serviceEndpoint: "https://pds.invalid",
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
            await inObj(stub, async (obj) => {
                await obj.complete(did, "3m1", 1_000, VERIFIED)
                await obj.completeDeletion(did, 2_000, false)
                expect(await obj.holderStateOf(did)).toBe("gone-reversible")
                expect(await obj.isWatched(did)).toBe(false)
                const head = await (
                    obj as unknown as { fetchHeadRev(did: string): Promise<{ rev: string }> }
                ).fetchHeadRev(did)
                expect(head.rev).toBe("3m5")
            })
        } finally {
            globalThis.fetch = original
        }
        expect(await rows(stub, `SELECT did FROM did_documents WHERE did = '${did}'`)).toEqual([])
    })
})
