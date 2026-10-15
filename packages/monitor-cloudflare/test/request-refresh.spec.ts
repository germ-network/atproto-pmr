/**
 * A device read of a lapsed declaration reorders the refresh queue without
 * making anything due that was not, and without letting anonymous reads
 * pin failing sources at the head.
 */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv
const VERIFIED = { cid: "bafyreistub", verifiedWith: "zKey" }
const HOUR = 3_600_000
const DAY = 24 * HOUR

let n = 0
const freshStub = () => {
    n += 1
    return testEnv.ingest.get(testEnv.ingest.idFromName(`request-refresh-${n}`))
}
const inObj = <R>(fn: (obj: MonitorIngest, sql: SqlStorage) => Promise<R>) =>
    runInDurableObject(freshStub(), (obj, state) => fn(obj as MonitorIngest, state.storage.sql))

/** Holders confirmed `agesMs` ago, in the given order. */
async function hold(obj: MonitorIngest, now: number, agesMs: number[]): Promise<string[]> {
    const dids = agesMs.map((_, i) => `did:plc:h${i}`)
    for (const [i, did] of dids.entries()) {
        await obj.complete(did, "3m1", now - agesMs[i]!, VERIFIED)
    }
    return dids
}

const due = (obj: MonitorIngest, now: number, limit = 50) =>
    obj.dueRefresh(now - HOUR, limit, now - DAY)

describe("MonitorIngest.requestRefresh", () => {
    it("a requested DID that is due comes ahead of due DIDs not requested", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const [oldest, mid, newest] = await hold(obj, now, [5 * HOUR, 3 * HOUR, 2 * HOUR])
            expect(await due(obj, now)).toEqual([oldest, mid, newest])
            await obj.requestRefresh(newest!, now)
            expect(await due(obj, now)).toEqual([newest, oldest, mid])
        })
    })

    it("a request for a DID confirmed since its bound changes nothing", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const [stale, fresh] = await hold(obj, now, [3 * HOUR, HOUR / 2])
            await obj.requestRefresh(fresh!, now)
            expect(await due(obj, now)).toEqual([stale])
        })
    })

    it("a request for a DID attempted since its bound changes nothing", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const [stale, attempted] = await hold(obj, now, [3 * HOUR, 4 * HOUR])
            await obj.markAttempted(attempted!, now - HOUR / 2)
            await obj.requestRefresh(attempted!, now)
            expect(await due(obj, now)).toEqual([stale])
        })
    })

    it("requested DIDs fill at most a quarter of a batch, the rest in the usual order", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const dids = await hold(
                obj,
                now,
                [10, 9, 8, 7, 6, 5, 4, 3].map((h) => h * HOUR)
            )
            // The three newest are requested, the oldest request first.
            await obj.requestRefresh(dids[7]!, now - 3)
            await obj.requestRefresh(dids[6]!, now - 2)
            await obj.requestRefresh(dids[5]!, now - 1)
            expect(await due(obj, now, 8)).toEqual([
                dids[7],
                dids[6],
                dids[0],
                dids[1],
                dids[2],
                dids[3],
                dids[4],
                dids[5],
            ])
        })
    })

    it("a batch under four still takes one requested DID", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const [a, b, c] = await hold(obj, now, [5 * HOUR, 4 * HOUR, 3 * HOUR])
            await obj.requestRefresh(c!, now)
            expect(await due(obj, now, 2)).toEqual([c, a])
            await obj.requestRefresh(b!, now)
            expect(await due(obj, now, 1)).toEqual([b])
        })
    })

    it("repeated requests for one DID yield it once", async () => {
        await inObj(async (obj) => {
            const now = Date.now()
            const [a, b] = await hold(obj, now, [5 * HOUR, 4 * HOUR])
            await obj.requestRefresh(b!, now - 2)
            await obj.requestRefresh(b!, now - 1)
            await obj.requestRefresh(b!, now)
            expect(await due(obj, now)).toEqual([b, a])
        })
    })

    it("dueRefresh returning a DID clears its request", async () => {
        await inObj(async (obj, sql) => {
            const now = Date.now()
            const [a, b] = await hold(obj, now, [5 * HOUR, 4 * HOUR])
            await obj.requestRefresh(b!, now)
            await due(obj, now)
            expect(sql.exec("SELECT did FROM refresh_requests").toArray()).toEqual([])
            // The request is spent: an unchanged queue comes back in the usual order.
            expect(await due(obj, now)).toEqual([a, b])
        })
    })

    it("a request for a DID outside the interest set changes nothing", async () => {
        await inObj(async (obj, sql) => {
            const now = Date.now()
            const [a] = await hold(obj, now, [5 * HOUR])
            await obj.requestRefresh("did:plc:stranger", now)
            expect(sql.exec("SELECT did FROM refresh_requests").toArray()).toEqual([])
            expect(await due(obj, now)).toEqual([a])
        })
    })

    it("a DID leaving interest has its request deleted", async () => {
        await inObj(async (obj, sql) => {
            const now = Date.now()
            const [a] = await hold(obj, now, [5 * HOUR])
            await obj.requestRefresh(a!, now)
            await obj.forgetLeft(a!)
            expect(sql.exec("SELECT did FROM refresh_requests").toArray()).toEqual([])
        })
    })

    it("a request a day old is dropped without selection", async () => {
        await inObj(async (obj, sql) => {
            const now = Date.now()
            const [a, b] = await hold(obj, now, [5 * HOUR, 4 * HOUR])
            await obj.requestRefresh(b!, now - DAY - 1)
            expect(await due(obj, now)).toEqual([a, b])
            expect(sql.exec("SELECT did FROM refresh_requests").toArray()).toEqual([])
        })
    })

    it("a repeated request does not extend a request's day", async () => {
        await inObj(async (obj, sql) => {
            const now = Date.now()
            const [a, b] = await hold(obj, now, [5 * HOUR, 4 * HOUR])
            await obj.requestRefresh(b!, now - DAY - 1)
            await obj.requestRefresh(b!, now)
            expect(await due(obj, now)).toEqual([a, b])
            expect(sql.exec("SELECT did FROM refresh_requests").toArray()).toEqual([])
        })
    })
})
