/**
 * The allow list in the real Durable Object: who is in interest under each
 * policy, how registrations reach it, and what joining and leaving do to
 * everything kept for a DID.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { RecordNotFoundError } from "@germ-network/atproto-pmr-core"
import {
    applyInterestTransitions,
    intakePlcEvent,
    settle,
    settleDeletion,
    settleDue,
    type FetchedRecord,
    type IngestDeps,
    type PlcExportEvent,
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
            expect(await store.getSecondary({ did, collection: PROFILE, rkey: "self" })).toBeNull()
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

    it.todo("a secondary settle for a DID not in interest stores nothing")

    it("a declaration deletion keeps the profile of a DID still in interest", async () => {
        const did = uniqDid()
        await inObj(registeredStub(), async (obj) => {
            await obj.setRegistered(did, true, 1)
            await withSnapshots(obj, did)
            await settleDeletion((obj as unknown as Internals).deps(), did, false)
            const store = kvSnapshotStore(testEnv)
            expect(await store.getRecord(did)).toBeNull()
            expect(await store.getSecondary({ did, collection: PROFILE, rkey: "self" })).not.toBeNull()
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

    it("a join settle that finds the declaration gone records gone-reversible without a window entry or onDelete", async () => {
        const stub = registeredStub()
        const did = uniqDid()
        let pushed: string[] = []
        await inObj(stub, async (obj) => {
            pushed = drive(obj, async () => {
                throw new RecordNotFoundError("no record", false)
            }).pushed
            await obj.setRegistered(did, true, 1)
            await applyTransitions(obj)
            await settleOwed(obj)
            expect(await obj.holderStateOf(did)).toBe("gone-reversible")
            expect(await obj.isDeleted(did)).toBe(false)
        })
        expect(pushed).toEqual([])
        expect(await windowCount(stub)).toBe(0)
        expect(await rows(stub, "SELECT did FROM pending")).toEqual([])
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
            expect(await store.getSecondary({ did, collection: PROFILE, rkey: "self" })).not.toBeNull()
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
            await applyTransitions(obj)
            await settleOwed(obj)
            expect(await obj.isDeleted(did)).toBe(true)
        })
        expect(pushed).toEqual([])
        expect(await windowCount(stub)).toBe(0)
    })
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
