/**
 * The follow/profile stream against the real Durable Object: its own socket,
 * cursor and reconnect, and how each event is routed in the read loop.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeEvent, routeFollowEvent } from "@germ-network/atproto-pmr-monitor"
import { monitorCollections, type MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv & {
    ingestRegistered: DurableObjectNamespace<MonitorIngest>
}
const FOLLOW = "app.bsky.graph.follow"
const BLOCK = "app.bsky.graph.block"
const PROFILE = "app.bsky.actor.profile"

let n = 0
const registeredStub = () => {
    n += 1
    return testEnv.ingestRegistered.get(testEnv.ingestRegistered.idFromName(`follow-${n}`))
}
let d = 0
const uniqDid = () => `did:plc:f${(d += 1)}x${crypto.randomUUID().slice(0, 8)}`
const inObj = <R>(stub: DurableObjectStub<MonitorIngest>, fn: (obj: MonitorIngest) => Promise<R>) =>
    runInDurableObject(stub, (obj) => fn(obj as MonitorIngest))
const rows = <R extends Record<string, unknown>>(
    stub: DurableObjectStub<MonitorIngest>,
    sql: string
) =>
    runInDurableObject(stub, (_o, state) => state.storage.sql.exec<R>(sql).toArray()) as Promise<R[]>
const meta = async (stub: DurableObjectStub<MonitorIngest>, k: string) =>
    (await rows<{ v: string }>(stub, `SELECT v FROM meta WHERE k = '${k}'`))[0]?.v ?? null

/** A stand-in Jetstream: every upgrade hands the object one end of a socket pair and keeps the other. */
function stubJetstream() {
    const requests: URL[] = []
    const servers: { url: URL; ws: WebSocket }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(url)
        const [client, server] = Object.values(new WebSocketPair())
        server!.accept()
        servers.push({ url, ws: server! })
        return new Response(null, { status: 101, webSocket: client })
    }) as typeof fetch
    return {
        requests,
        servers,
        restore: () => {
            globalThis.fetch = original
        },
        followRequests: () => requests.filter((u) => u.searchParams.getAll("collections").includes(FOLLOW)),
        declarationRequests: () =>
            requests.filter((u) => u.searchParams.get("collections") === testEnv.MONITOR_COLLECTION),
        followServer: () => servers.filter((s) => s.url.searchParams.getAll("collections").includes(FOLLOW)).at(-1)!,
    }
}

let jet: ReturnType<typeof stubJetstream> | null = null
afterEach(() => {
    jet?.restore()
    jet = null
    vi.restoreAllMocks()
})

/** Sockets belong to the object that made them, so frames are pushed from inside it. */
const push = (stub: DurableObjectStub<MonitorIngest>, ws: WebSocket, ...frames: string[]) =>
    inObj(stub, async () => {
        for (const f of frames) ws.send(f)
    })

const frame = (e: Record<string, unknown>) => JSON.stringify(e)
const commit = (
    did: string,
    collection: string,
    operation: string,
    rkey: string,
    timeUs: number,
    record?: Record<string, unknown>,
    rev = `3r${timeUs}`
) =>
    frame({
        did,
        time_us: timeUs,
        kind: "commit",
        commit: { rev, operation, collection, rkey, cid: "bafy", ...(record ? { record } : {}) },
    })
const identity = (did: string, timeUs: number) =>
    frame({ did, time_us: timeUs, kind: "identity", identity: { did } })

const event = (raw: string) => {
    const e = decodeEvent(raw)
    if (e === null) throw new Error("undecodable test frame")
    return e
}
const route = (obj: MonitorIngest, raw: string, cursor = "1000") =>
    routeFollowEvent({ index: obj, secondaries: monitorCollections(obj.env) }, event(raw), cursor)

describe("follow/profile socket", () => {
    it("socket subscribes to follow, block and profile collections without dids", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        await inObj(stub, (obj) => obj.connectFollow())
        const [req] = jet.followRequests()
        // Jetstream rejects a comma list; each collection must be its own param.
        expect(req!.searchParams.getAll("collections").sort()).toEqual([FOLLOW, BLOCK, PROFILE].sort())
        expect(req!.search).not.toContain("%2C")
        expect(req!.searchParams.has("dids")).toBe(false)
        expect(req!.searchParams.has("wantedDids")).toBe(false)
        expect(req!.searchParams.has("cursor")).toBe(false)
    })

    it("resumes from its own cursor and never writes meta.cursor", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        await inObj(stub, async (obj) => {
            obj.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('follow_cursor', '5000'), ('cursor', '999')")
            await obj.connectFollow()
        })
        expect(jet.followRequests()[0]!.searchParams.get("cursor")).toBe("5000")
        const owner = uniqDid()
        await inObj(stub, (obj) => obj.setRegistered(owner, true, 1))
        await push(stub, jet.followServer().ws, commit(owner, FOLLOW, "create", "r1", 6000, { subject: "did:plc:x" }))
        await vi.waitFor(async () => expect(await meta(stub, "follow_cursor")).toBe("6000"))
        expect(await meta(stub, "cursor")).toBe("999")
    })

    it("a closed socket is reconnected without touching the declaration socket", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        await inObj(stub, (obj) => obj.start())
        expect(jet.declarationRequests()).toHaveLength(1)
        expect(jet.followRequests()).toHaveLength(1)

        const followWs = jet.followServer().ws
        await inObj(stub, async () => followWs.close(1000, "bye"))
        await vi.waitFor(async () => {
            const open = await inObj(stub, async (obj) => (obj as unknown as { followSocket: unknown }).followSocket)
            expect(open).toBeNull()
        })
        await runDurableObjectAlarm(stub)
        expect(jet.followRequests()).toHaveLength(2)
        expect(jet.declarationRequests()).toHaveLength(1)

        // The declaration socket closing leaves the follow socket open.
        const declWs = jet.servers.find((s) => s.url === jet!.declarationRequests()[0])!.ws
        await inObj(stub, async () => declWs.close(1000, "bye"))
        await vi.waitFor(async () => {
            const decl = await inObj(stub, async (obj) => (obj as unknown as { socket: unknown }).socket)
            expect(decl).toBeNull()
        })
        const follow = await inObj(stub, async (obj) => (obj as unknown as { followSocket: unknown }).followSocket)
        expect(follow).not.toBeNull()
    })

    it("last_connected_at is refreshed while the socket stays open and survives eviction", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        const start = Date.now()
        await inObj(stub, (obj) => obj.connectFollow())
        const opened = Number(await meta(stub, "last_connected_at"))
        expect(opened).toBeGreaterThanOrEqual(start)

        vi.spyOn(Date, "now").mockReturnValue(opened + 60_000)
        await push(stub, jet.followServer().ws, identity(uniqDid(), 1000))
        await vi.waitFor(async () => expect(Number(await meta(stub, "last_connected_at"))).toBe(opened + 60_000))

        const followWs = jet.followServer().ws
        await inObj(stub, async () => followWs.close(1000, "bye"))
        vi.restoreAllMocks()
        await evictDurableObject(stub)
        expect(Number(await meta(stub, "last_connected_at"))).toBe(opened + 60_000)
    })

    it("a long-open socket does not read as an outage", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        await inObj(stub, (obj) => obj.start())
        const opened = Number(await meta(stub, "last_connected_at"))
        const hour = 3_600_000
        for (let i = 1; i <= 3; i += 1) {
            const now = opened + i * 12 * hour
            vi.spyOn(Date, "now").mockReturnValue(now)
            await push(stub, jet.followServer().ws, identity(uniqDid(), i * 1000))
            await vi.waitFor(async () => expect(Number(await meta(stub, "last_connected_at"))).toBe(now))
        }
        // A socket that goes silent is not vouched for by the alarm.
        vi.spyOn(Date, "now").mockReturnValue(opened + 40 * hour)
        await runDurableObjectAlarm(stub)
        expect(Number(await meta(stub, "last_connected_at"))).toBe(opened + 36 * hour)
    })

    it("dropped events advance the persisted cursor at most once per interval", async () => {
        jet = stubJetstream()
        const stub = registeredStub()
        await inObj(stub, (obj) => obj.connectFollow())
        const base = Date.now()
        vi.spyOn(Date, "now").mockReturnValue(base)
        const server = jet.followServer().ws
        await push(stub, server, identity(uniqDid(), 1000))
        await vi.waitFor(async () => expect(await meta(stub, "follow_cursor")).toBe("1000"))
        await push(stub, server, identity(uniqDid(), 2000), identity(uniqDid(), 3000))
        await new Promise((r) => setTimeout(r, 50))
        expect(await meta(stub, "follow_cursor")).toBe("1000")

        vi.spyOn(Date, "now").mockReturnValue(base + 5_001)
        await push(stub, server, identity(uniqDid(), 4000))
        await vi.waitFor(async () => expect(await meta(stub, "follow_cursor")).toBe("4000"))
    })

    it("a kept event with a lower cursor is logged without lowering the cursor", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            await route(obj, commit(owner, FOLLOW, "create", "a", 2000, { subject: "did:plc:x" }), "2000")
            await route(obj, commit(owner, FOLLOW, "create", "b", 1000, { subject: "did:plc:y" }), "1000")
        })
        expect(await rows(stub, "SELECT rkey FROM edge_ops ORDER BY seq")).toEqual([{ rkey: "a" }, { rkey: "b" }])
        expect(await meta(stub, "follow_cursor")).toBe("2000")
    })

    it("follow_cursor is written with the kept event", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            await obj.skipFollowEvent("1000") // persisted, so a skip within the interval writes nothing
            await route(obj, commit(owner, FOLLOW, "create", "a", 2000, { subject: "did:plc:x" }), "2000")
        })
        expect(await meta(stub, "follow_cursor")).toBe("2000")
        expect(await rows(stub, "SELECT cursor FROM edge_ops")).toEqual([{ cursor: "2000" }])
    })
})

describe("follow/profile routing", () => {
    const account = (did: string, timeUs: number, active: boolean) =>
        frame({ did, time_us: timeUs, kind: "account", account: { did, active, status: active ? null : "takendown" } })
    const sync = (did: string, timeUs: number) => frame({ did, time_us: timeUs, kind: "sync", sync: { did } })
    const ops = (stub: DurableObjectStub<MonitorIngest>) =>
        rows(stub, "SELECT kind, follower, rkey, subject, rev, cursor FROM edge_ops ORDER BY seq")

    it("owner follow create lands in edge_ops with rev and cursor", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(
                await route(obj, commit(owner, FOLLOW, "create", "r1", 1234, { subject: "did:plc:x" }, "3rev"), "1234")
            ).toBe("edge-op")
        })
        expect(await ops(stub)).toEqual([
            { kind: "create", follower: owner, rkey: "r1", subject: "did:plc:x", rev: "3rev", cursor: "1234" },
        ])
        expect(await meta(stub, "follow_cursor")).toBe("1234")
    })

    it("follow of a registered user by an interest DID lands in edge_ops", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        const follower = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            await obj.setOwnerFollowers(follower, 1, 1)
            expect(await route(obj, commit(follower, FOLLOW, "create", "r1", 10, { subject: owner }))).toBe("edge-op")
        })
        expect(await ops(stub)).toMatchObject([{ kind: "create", follower, subject: owner }])
    })

    it("follow by a DID outside interest is dropped", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(await route(obj, commit(uniqDid(), FOLLOW, "create", "r1", 10, { subject: owner }))).toBe("dropped")
            expect(await route(obj, commit(uniqDid(), FOLLOW, "delete", "r1", 11))).toBe("dropped")
        })
        expect(await ops(stub)).toEqual([])
    })

    it("delete by an interest follower lands in edge_ops", async () => {
        const stub = registeredStub()
        const follower = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setOwnerFollowers(follower, 1, 1)
            expect(await route(obj, commit(follower, FOLLOW, "delete", "r9", 77, undefined, "3del"), "77")).toBe("edge-op")
        })
        expect(await ops(stub)).toEqual([
            { kind: "delete", follower, rkey: "r9", subject: null, rev: "3del", cursor: "77" },
        ])
    })

    it("follow update without subject is ignored", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(await route(obj, commit(owner, FOLLOW, "update", "r1", 10))).toBe("dropped")
        })
        expect(await ops(stub)).toEqual([])
    })

    it("follow update with a subject routes like a create", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(await route(obj, commit(owner, FOLLOW, "update", "r1", 10, { subject: "did:plc:new" }))).toBe("edge-op")
        })
        expect(await ops(stub)).toMatchObject([{ kind: "create", follower: owner, rkey: "r1", subject: "did:plc:new" }])
    })

    it("a create without a subject is dropped", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(await route(obj, commit(owner, FOLLOW, "create", "r1", 10))).toBe("dropped")
            expect(await route(obj, commit(owner, FOLLOW, "create", "r2", 11, { subject: 5 }))).toBe("dropped")
        })
        expect(await ops(stub)).toEqual([])
    })

    it("follow of an unregistered DID by a non-owner interest DID is dropped", async () => {
        const stub = registeredStub()
        const follower = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setOwnerFollowers(follower, 1, 1)
            expect(await route(obj, commit(follower, FOLLOW, "create", "r1", 10, { subject: uniqDid() }))).toBe("dropped")
        })
        expect(await ops(stub)).toEqual([])
    })

    it("identity is dropped", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            obj.ctx.storage.sql.exec("DELETE FROM listing_requeue")
            expect(await route(obj, identity(owner, 10))).toBe("dropped")
        })
        expect(await ops(stub)).toEqual([])
        expect(await rows(stub, "SELECT did FROM listing_requeue")).toEqual([])
    })

    it("#sync of an interest DID re-queues its listing", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            expect(await route(obj, sync(owner, 10), "10")).toBe("relist")
            expect(await route(obj, sync(owner, 11), "11")).toBe("relist")
            expect(await route(obj, sync(uniqDid(), 12), "12")).toBe("dropped")
        })
        expect(await rows(stub, "SELECT did FROM listing_requeue")).toEqual([{ did: owner }])
        expect(await meta(stub, "follow_cursor")).toBe("11")
    })

    it("#account active=true of an interest DID re-queues its listing", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            obj.ctx.storage.sql.exec("DELETE FROM listing_requeue")
            expect(await route(obj, account(owner, 10, false))).toBe("dropped")
            expect(obj.ctx.storage.sql.exec("SELECT did FROM listing_requeue").toArray()).toEqual([])
            expect(await route(obj, account(owner, 11, true))).toBe("relist")
            expect(await route(obj, account(uniqDid(), 12, true))).toBe("dropped")
        })
        expect(await rows(stub, "SELECT did FROM listing_requeue")).toEqual([{ did: owner }])
    })

    it("edge_ops seq is never reused after the table empties", async () => {
        const stub = registeredStub()
        const owner = uniqDid()
        await inObj(stub, async (obj) => {
            await obj.setRegistered(owner, true, 1)
            await route(obj, commit(owner, FOLLOW, "create", "a", 10, { subject: "did:plc:x" }))
            obj.ctx.storage.sql.exec("DELETE FROM edge_ops")
            await route(obj, commit(owner, FOLLOW, "create", "b", 11, { subject: "did:plc:x" }))
        })
        expect(await rows(stub, "SELECT seq FROM edge_ops")).toEqual([{ seq: 2 }])
    })
})
