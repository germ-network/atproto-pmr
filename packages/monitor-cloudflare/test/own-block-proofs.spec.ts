/**
 * A registered owner's own block records are held by rkey as proof CARs, so
 * the record route can serve them, and only while the owner stays
 * registered. Absence is never held: the device confirms it with the owner's
 * own PDS.
 */
import { describe, expect, it } from "vitest"
import {
    disposeStrayOwnBlockProofs,
    routeFollowEvent,
    settleSecondaryDue,
    type CommitEvent,
    type FetchedRecord,
    type RecordRef,
    type SecondaryDeps,
    type VerifyOutcome,
} from "@germ-network/atproto-pmr-monitor"
import { kvRecordSnapshots, kvSnapshotStore } from "../src/snapshot-store"
import type { MonitorIngest } from "../src/ingest-object"
import {
    alarm,
    entriesOf,
    inObj,
    queuedDids,
    queueRow,
    registeredStub,
    everyoneStub,
    rowsOf,
    setEnv,
    sql,
    step,
    stubNet,
    testEnv,
} from "./listing-harness"

const BLOCK = "app.bsky.graph.block"
const KEY = "zKey"
let d = 0
const uniqDid = () => `did:plc:obp${(d += 1)}x${crypto.randomUUID().slice(0, 8)}`

type Internals = {
    secondaryDeps(): SecondaryDeps
    fetchRecordAt: (ref: RecordRef) => Promise<FetchedRecord>
    verifyRecordAt: (ref: RecordRef, record: FetchedRecord) => Promise<VerifyOutcome>
}

/** The record fetch answers with a CAR of the given rev, or proves the record absent. */
function stubFetch(obj: MonitorIngest, answer: (ref: RecordRef) => "absent" | { rev: string }) {
    const o = obj as unknown as Internals
    const fetched: string[] = []
    o.fetchRecordAt = async (ref) => {
        fetched.push(`${ref.did}/${ref.rkey}`)
        return { car: new Uint8Array([5]), source: "https://pds", signingKey: KEY, ref } as unknown as FetchedRecord
    }
    o.verifyRecordAt = async (ref) => {
        const a = answer(ref)
        return a === "absent"
            ? { kind: "verified-absent", key: KEY, rev: "3z9", commitCid: "bafycommit" }
            : { kind: "verified", key: KEY, rev: a.rev, cid: `bafyrei${ref.rkey}` }
    }
    return {
        fetched,
        deps: () => o.secondaryDeps(),
        drain: (limit = 32) => settleSecondaryDue(o.secondaryDeps(), limit, undefined, "own-blocks"),
    }
}

const blockEvent = (did: string, rkey: string, overrides: Partial<CommitEvent> = {}): CommitEvent => ({
    kind: "commit",
    did,
    collection: BLOCK,
    rkey,
    operation: "create",
    rev: "3r1",
    cid: null,
    seq: null,
    timeMs: null,
    subject: "did:plc:blocked",
    ...overrides,
})
const route = (obj: MonitorIngest, event: CommitEvent) =>
    routeFollowEvent({ index: obj, secondaries: [] }, event, "10")
const served = (did: string, rkey: string) => kvRecordSnapshots(testEnv).get(did, BLOCK, rkey)
const pendingBlocks = (obj: MonitorIngest, did: string) =>
    rowsOf<{ rkey: string; rev: string; epoch: number }>(
        obj,
        "SELECT rkey, rev, epoch FROM rec_pending WHERE did = ? AND collection = ? ORDER BY rkey",
        did,
        BLOCK
    )
const heldBlocks = (obj: MonitorIngest, did: string) =>
    rowsOf<{ rkey: string }>(obj, "SELECT rkey FROM records WHERE did = ? AND collection = ? ORDER BY rkey", did, BLOCK).map(
        (r) => r.rkey
    )

describe("MonitorIngest — own-block proofs: live ops and the own lane", () => {
    it("a registered owner's live block create is fetched, verified and served by kvRecordSnapshots", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.setRegistered(did, true, 1)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            expect(await route(obj, blockEvent(did, "3kb"))).toBe("edge-op")
            expect(await net.drain()).toBe(1)
            expect(net.fetched).toEqual([`${did}/3kb`])
            expect(await served(did, "3kb")).toMatchObject({ rev: "3r1", cid: "bafyrei3kb", verifiedWith: KEY })
            expect(pendingBlocks(obj, did)).toEqual([])
            expect(heldBlocks(obj, did)).toEqual(["3kb"])
        })
    })

    it("a later block delete removes the held proof, so the rkey reads not-held", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.setRegistered(did, true, 1)
            let answer: "absent" | { rev: string } = { rev: "3r1" }
            const net = stubFetch(obj, () => answer)
            await route(obj, blockEvent(did, "3kb"))
            await net.drain()
            expect(await served(did, "3kb")).not.toBeNull()
            answer = "absent"
            expect(await route(obj, blockEvent(did, "3kb", { operation: "delete", subject: null, rev: "3z9" }))).toBe(
                "edge-op"
            )
            expect(pendingBlocks(obj, did)).toMatchObject([{ rkey: "3kb", rev: "3z9" }])
            await net.drain()
            expect(await served(did, "3kb")).toBeNull()
            expect(heldBlocks(obj, did)).toEqual([])
            expect(pendingBlocks(obj, did)).toEqual([])
        })
    })

    it("a block op by a followed DID that is not registered owes no proof", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.setOwnerFollowers(did, 1, 1)
            expect(await obj.inInterest(did)).toBe(true)
            await route(obj, blockEvent(did, "3kb"))
            await route(obj, blockEvent(did, "3kc", { operation: "delete", subject: null }))
            expect(pendingBlocks(obj, did)).toEqual([])
        })
    })

    it("own-block proofs drain under OWN_BLOCK_SETTLE_BATCH and never take a SETTLE_BATCH slot", async () => {
        const stub = registeredStub("obp")
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(did, true, 1)
            // The alarm's daily reconcile keeps only the directory's DIDs registered.
            const pmrDirectory = {
                list: async () => ({ keys: [{ name: did }], list_complete: true }),
            } as unknown as KVNamespace
            ;(obj as unknown as { env: unknown }).env = { ...obj.env, pmrDirectory }
            setEnv(obj, { SETTLE_BATCH: "1", OWN_BLOCK_SETTLE_BATCH: "2" })
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            for (const rkey of ["3ka", "3kb", "3kc"]) await route(obj, blockEvent(did, rkey))
            await obj.oweSecondary(
                { did, collection: "app.bsky.actor.profile", rkey: "self", rev: "3r1" },
                "11"
            )
            await (obj as unknown as { armWatchdog(): Promise<void> }).armWatchdog()
            expect(net.fetched).toEqual([])
        })
        await alarm(stub)
        await inObj(stub, async (obj) => {
            expect(heldBlocks(obj, did)).toHaveLength(2)
            expect(pendingBlocks(obj, did)).toHaveLength(1)
            expect(rowsOf(obj, "SELECT 1 FROM rec_pending WHERE collection != ?", BLOCK)).toEqual([])
        })
    })
})

describe("MonitorIngest — own-block proofs: deregistration", () => {
    async function followedOwner(obj: MonitorIngest, did: string) {
        await obj.setRegistered(did, true, 1)
        await obj.setOwnerFollowers(did, 1, 1)
    }
    const dispose = (obj: MonitorIngest, deps = (obj as unknown as Internals).secondaryDeps()) =>
        disposeStrayOwnBlockProofs(deps, 32)

    it("deregistering an owner who is still followed disposes their block proofs from KV and the index", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await followedOwner(obj, did)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            await route(obj, blockEvent(did, "3ka"))
            await route(obj, blockEvent(did, "3kb"))
            await net.drain()
            expect(heldBlocks(obj, did)).toHaveLength(2)
            await obj.setRegistered(did, false, 2)
            expect(await obj.inInterest(did)).toBe(true)
            expect(await dispose(obj)).toBe(2)
            expect(heldBlocks(obj, did)).toEqual([])
            expect(await served(did, "3ka")).toBeNull()
            expect(await served(did, "3kb")).toBeNull()
        })
    })

    it("a proof owed before deregistration and settled after stores nothing, and its pending row is swept", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await followedOwner(obj, did)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            await route(obj, blockEvent(did, "3ka"))
            const [owed] = await obj.dueSecondaries(Date.now(), 10, "own-blocks")
            await obj.setRegistered(did, false, 2)
            const o = obj as unknown as Internals
            const { settleSecondary } = await import("@germ-network/atproto-pmr-monitor")
            expect(await settleSecondary(o.secondaryDeps(), owed!)).toBe("left")
            expect(net.fetched).toHaveLength(1)
            expect(await served(did, "3ka")).toBeNull()
            expect(heldBlocks(obj, did)).toEqual([])
            expect(pendingBlocks(obj, did)).toEqual([])
        })
    })

    it("deregistering mid-backfill sweeps every owed block fetch, so none is refetched", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await followedOwner(obj, did)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            for (const rkey of ["3ka", "3kb", "3kc", "3kd"]) await route(obj, blockEvent(did, rkey))
            await obj.setRegistered(did, false, 2)
            expect(await dispose(obj)).toBe(4)
            expect(pendingBlocks(obj, did)).toEqual([])
            expect(await net.drain()).toBe(0)
            expect(net.fetched).toEqual([])
        })
    })

    it("an owner who registers again between disposal's KV delete and its index step is fetched and served again", async () => {
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await followedOwner(obj, did)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            await route(obj, blockEvent(did, "3ka"))
            await net.drain()
            await obj.setRegistered(did, false, 2)
            const deps = (obj as unknown as Internals).secondaryDeps()
            const deleteSecondary = deps.snapshot.deleteSecondary
            deps.snapshot.deleteSecondary = async (ref) => {
                await deleteSecondary(ref)
                await obj.setRegistered(did, true, 3)
            }
            expect(await dispose(obj, deps)).toBe(1)
            expect(heldBlocks(obj, did)).toEqual([])
            expect(pendingBlocks(obj, did)).toMatchObject([{ rkey: "3ka", rev: "" }])
            expect(await net.drain()).toBe(1)
            expect(await served(did, "3ka")).toMatchObject({ verifiedWith: KEY })
        })
    })

    it("the alarm disposes a deregistered owner's block proofs", async () => {
        const stub = registeredStub("obp")
        const did = uniqDid()
        await inObj(stub, async (obj) => {
            await followedOwner(obj, did)
            const net = stubFetch(obj, () => ({ rev: "3r1" }))
            await route(obj, blockEvent(did, "3ka"))
            await net.drain()
            expect(heldBlocks(obj, did)).toEqual(["3ka"])
            await obj.setRegistered(did, false, 2)
            const pmrDirectory = {
                list: async () => ({ keys: [], list_complete: true }),
            } as unknown as KVNamespace
            ;(obj as unknown as { env: unknown }).env = { ...obj.env, pmrDirectory }
        })
        await alarm(stub)
        await inObj(stub, async (obj) => {
            expect(heldBlocks(obj, did)).toEqual([])
            expect(await served(did, "3ka")).toBeNull()
        })
    })
})

describe("MonitorIngest — own-block proofs: backfill at listing", () => {
    const O = "did:plc:obpowner"
    const listed = (rkeys: string[]) => rkeys.map((rkey) => ({ rkey, subject: `did:plc:s${rkey}` }))

    it("completing a registered owner's listing owes a proof for every listed block not held", async () => {
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            stubNet(obj, { repos: { [O]: entriesOf(1) }, blockRepos: { [O]: listed(["3ka", "3kb", "3kc"]) } })
            // 3ka is already held
            await obj.completeSecondary({ did: O, collection: BLOCK, rkey: "3ka" }, "3r1", { cid: "c", verifiedWith: KEY }, 1, "")
            expect(await step(obj)).toEqual(["listed"])
            expect(pendingBlocks(obj, O)).toMatchObject([
                { rkey: "3kb", rev: "" },
                { rkey: "3kc", rev: "" },
            ])
        })
    })

    it("completing a listing owes a re-fetch of a held block no longer listed", async () => {
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.register(O)
            await obj.setOwnerFollowers(O, 1, 1)
            stubNet(obj, { repos: { [O]: entriesOf(1) }, blockRepos: { [O]: listed(["3ka"]) } })
            for (const rkey of ["3ka", "3kgone"]) {
                await obj.completeSecondary({ did: O, collection: BLOCK, rkey }, "3r1", { cid: "c", verifiedWith: KEY }, 1, "")
            }
            expect(await step(obj)).toEqual(["listed"])
            expect(pendingBlocks(obj, O)).toMatchObject([{ rkey: "3kgone", rev: "" }])
        })
    })

    it("completing the listing of a graph owner who is not registered owes no proofs", async () => {
        await inObj(everyoneStub("obp"), async (obj) => {
            await obj.complete(O, "rev1", Date.now(), { cid: "bafy", verifiedWith: KEY })
            sql(obj, "DELETE FROM listing_requeue")
            stubNet(obj, { repos: { [O]: entriesOf(1) }, blockRepos: { [O]: listed(["3ka", "3kb"]) } })
            await obj.queueListing(O, Date.now(), "join")
            expect(await step(obj)).toEqual(["listed"])
            expect(await obj.isGraphOwner(O)).toBe(true)
            expect(await obj.isRegistered(O)).toBe(false)
            expect(pendingBlocks(obj, O)).toEqual([])
        })
    })
})

describe("MonitorIngest — own-block proofs: registration flip", () => {
    it("a registration false-to-true flip queues an ownership listing for a DID that already owns a graph, under either policy", async () => {
        const held = uniqDid()
        await inObj(everyoneStub("obp"), async (obj) => {
            await obj.complete(held, "rev1", Date.now(), { cid: "bafy", verifiedWith: KEY })
            sql(obj, "DELETE FROM listing_requeue")
            await obj.setRegistered(held, true, 2)
            expect(queuedDids(obj)).toEqual([held])
            expect(queueRow(obj, held)).toBeDefined()
        })
        const did = uniqDid()
        await inObj(registeredStub("obp"), async (obj) => {
            await obj.setRegistered(did, false, 1)
            sql(obj, "DELETE FROM listing_requeue")
            await obj.setRegistered(did, true, 2)
            expect(queuedDids(obj)).toEqual([did])
        })
    })

    it("re-confirming an already registered DID queues no listing", async () => {
        for (const stub of [everyoneStub("obp"), registeredStub("obp")]) {
            const did = uniqDid()
            await inObj(stub, async (obj) => {
                await obj.complete(did, "rev1", Date.now(), { cid: "bafy", verifiedWith: KEY })
                await obj.setRegistered(did, true, 1)
                sql(obj, "DELETE FROM listing_requeue")
                await obj.setRegistered(did, true, 2)
                expect(queuedDids(obj)).toEqual([])
            })
        }
    })
})
