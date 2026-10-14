/**
 * Where a record's snapshot lives in KV. The declaration's keys predate any
 * other collection and are already populated, so they must not move.
 */
import { DECLARATION_COLLECTION_NSID } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry } from "@germ-network/atproto-pmr-monitor"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { monitorCollections } from "../src/env"
import { kvRecordSnapshots, kvSnapshotStore, snapshotKeys } from "../src/snapshot-store"

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"

describe("snapshotKeys", () => {
    it("keeps the declaration's bare rec:<did> / chk:<did> keys", () => {
        expect(snapshotKeys(DID, DECLARATION_COLLECTION_NSID, "self")).toEqual({
            record: `rec:${DID}`,
            check: `chk:${DID}`,
        })
    })

    it("keys any other record by collection, rkey and DID", () => {
        expect(snapshotKeys(DID, "app.bsky.actor.profile", "self")).toEqual({
            record: `rec:app.bsky.actor.profile/self:${DID}`,
            check: `chk:app.bsky.actor.profile/self:${DID}`,
        })
    })

    it("keys a declaration record other than self by collection too", () => {
        expect(snapshotKeys(DID, DECLARATION_COLLECTION_NSID, "other")).toEqual({
            record: `rec:${DECLARATION_COLLECTION_NSID}/other:${DID}`,
            check: `chk:${DECLARATION_COLLECTION_NSID}/other:${DID}`,
        })
    })
})

const PROFILE = "app.bsky.actor.profile"
const entry = (rev: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
    rev,
    car: new Uint8Array([1, 2, 3]),
    observedAtMs: 1_000,
    source: "https://pds.example",
    signingKey: "zKey",
    verifiedWith: "zKey",
    cid: "bafyreicid",
    ...over,
})
const uniq = () => `did:plc:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`

describe("kvRecordSnapshots", () => {
    // One read surface serves the declaration and every secondary, with the
    // ingest's verdict, and a confirmation counts only at its own record's rev.
    it("declaration keeps bare rec:/chk: keys", async () => {
        const did = uniq()
        await kvSnapshotStore(env).putRecord(did, entry("3m1"))
        await kvSnapshotStore(env).putCheck(did, { rev: "3m1", checkedAtMs: 5_000 })
        expect(await env.records.get(`rec:${did}`)).not.toBeNull()
        const read = await kvRecordSnapshots(env).get(did, DECLARATION_COLLECTION_NSID, "self")
        expect(read).toMatchObject({
            verifiedWith: "zKey",
            rev: "3m1",
            cid: "bafyreicid",
            freshAtMs: 5_000,
        })
        expect(read!.car).toEqual(new Uint8Array([1, 2, 3]))
    })

    it("secondary round-trips under its collection-scoped keys", async () => {
        const did = uniq()
        const ref = { did, collection: PROFILE, rkey: "self" }
        await kvSnapshotStore(env).putSecondary(ref, entry("3m2"))
        expect(await env.records.get(`rec:${PROFILE}/self:${did}`)).not.toBeNull()
        expect(await env.records.get(`rec:${did}`)).toBeNull()
        expect(await kvRecordSnapshots(env).get(did, PROFILE, "self")).toMatchObject({
            rev: "3m2",
            freshAtMs: 1_000,
        })
        expect(await kvSnapshotStore(env).getSecondary(ref)).toMatchObject({ rev: "3m2" })
        await kvSnapshotStore(env).putSecondaryCheck(ref, { rev: "3m2", checkedAtMs: 9_000 })
        await kvSnapshotStore(env).deleteSecondary(ref)
        expect(await kvRecordSnapshots(env).get(did, PROFILE, "self")).toBeNull()
        expect(await env.records.get(`chk:${PROFILE}/self:${did}`)).toBeNull()
    })

    it("entry without verified metadata reads verifiedWith null", async () => {
        const did = uniq()
        await env.records.put(`rec:${did}`, new Uint8Array([9]), {
            metadata: { rev: "3m1", observedAtMs: 2_000, source: "s", signingKey: "zKey" },
        })
        expect(
            await kvRecordSnapshots(env).get(did, DECLARATION_COLLECTION_NSID, "self")
        ).toMatchObject({ verifiedWith: null, rev: null, cid: null, freshAtMs: 2_000 })
    })

    it("chk: for a secondary is honoured only at that record's rev", async () => {
        const did = uniq()
        const ref = { did, collection: PROFILE, rkey: "self" }
        await kvSnapshotStore(env).putSecondary(ref, entry("3m2"))
        await kvSnapshotStore(env).putSecondaryCheck(ref, { rev: "3m1", checkedAtMs: 9_000 })
        expect((await kvRecordSnapshots(env).get(did, PROFILE, "self"))!.freshAtMs).toBe(1_000)
        await kvSnapshotStore(env).putSecondaryCheck(ref, { rev: "3m2", checkedAtMs: 9_000 })
        expect((await kvRecordSnapshots(env).get(did, PROFILE, "self"))!.freshAtMs).toBe(9_000)
        await kvSnapshotStore(env).putSecondaryCheck(ref, { rev: "3m2", checkedAtMs: 500 })
        expect((await kvRecordSnapshots(env).get(did, PROFILE, "self"))!.freshAtMs).toBe(1_000)
    })

    it("unset or empty MONITOR_COLLECTIONS watches no secondary", () => {
        expect(monitorCollections({ ...env, MONITOR_COLLECTIONS: undefined })).toEqual([])
        expect(monitorCollections({ ...env, MONITOR_COLLECTIONS: " " })).toEqual([])
        expect(monitorCollections(env)).toEqual([{ collection: PROFILE, rkey: "self" }])
    })
})
