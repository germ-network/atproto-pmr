/**
 * A declaration snapshot carries its decoded policies in KV metadata, so a
 * verdict read and the owner summary's index read get them without parsing
 * the CAR.
 */
import { putV2Entry } from "./secondary-read"
import { DECLARATION_COLLECTION_NSID, type StoredPolicies } from "@germ-network/atproto-pmr-core"
import type { SnapshotEntry } from "@germ-network/atproto-pmr-monitor"
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import { declarationPoliciesMeta, kvRecordSnapshots, kvSnapshotStore } from "../src/snapshot-store"

const uniq = () => `did:plc:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`

/** A keyPackage with no succession proofs and the given policy byte. */
function keyPackage(policy: number): Uint8Array {
    const pkg = [0, policy, 1, 1]
    return Uint8Array.from([0, ...new Array(64).fill(5), pkg.length, ...pkg])
}

function declarationCar(did: string, record: Record<string, unknown>): Uint8Array {
    return buildRepoCar({
        did,
        key: makeKey(),
        records: { [`${DECLARATION_COLLECTION_NSID}/self`]: record },
    }).car
}

const entry = (car: Uint8Array, over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
    rev: "3kaaaaaaaaaaa",
    car,
    observedAtMs: 1_000,
    source: "https://pds.example",
    signingKey: "zKey",
    verifiedWith: "zKey",
    cid: "bafyreicid",
    ...over,
})

const metaOf = async (key: string) =>
    (await env.records.getWithMetadata<{ policies?: StoredPolicies }>(key)).metadata

describe("declarationPoliciesMeta", () => {
    it("a declaration CAR whose keyPackage parses yields its allow policies", () => {
        const car = declarationCar(uniq(), { keyPackage: keyPackage(1) })
        expect(declarationPoliciesMeta(car)).toEqual({ found: true, policies: ["bsky-follows"] })
    })

    it("a CAR with no readable declaration or keyPackage yields undecodable", () => {
        const undecodable = { found: false, code: "undecodable" }
        expect(declarationPoliciesMeta(new Uint8Array([1, 2, 3]))).toEqual(undecodable)
        expect(declarationPoliciesMeta(declarationCar(uniq(), { keyPackage: new Uint8Array([1]) }))).toEqual(undecodable)
        expect(declarationPoliciesMeta(declarationCar(uniq(), {}))).toEqual(undecodable)
        const other = buildRepoCar({ did: uniq(), key: makeKey(), records: { "app.bsky.actor.profile/self": {} } }).car
        expect(declarationPoliciesMeta(other)).toEqual(undecodable)
    })
})

describe("putRecord policies metadata", () => {
    it("every declaration write stores policies in rec:<did> metadata, from ingest, refresh and a seenKey update alike", async () => {
        const did = uniq()
        const store = kvSnapshotStore(env)
        const open = declarationCar(did, { keyPackage: keyPackage(2) })
        await store.putRecord(did, entry(open))
        expect((await metaOf(`rec:${did}`))!.policies).toEqual({ found: true, policies: ["open"] })

        const closed = declarationCar(did, { keyPackage: keyPackage(0) })
        await store.putRecord(did, entry(closed, { rev: "3kbbbbbbbbbbb" }))
        expect((await metaOf(`rec:${did}`))!.policies).toEqual({ found: true, policies: [] })

        await store.putRecord(did, entry(open, { seenKey: "k" }))
        expect((await metaOf(`rec:${did}`))!.policies).toEqual({ found: true, policies: ["open"] })
    })

    it("a seenKey-only update keeps the policies of the CAR it rewrites", async () => {
        const did = uniq()
        const store = kvSnapshotStore(env)
        const car = declarationCar(did, { keyPackage: keyPackage(1) })
        await store.putRecord(did, entry(car))
        const held = (await store.getRecord(did))!
        await store.putRecord(did, { ...held, seenKey: "fetched" })
        expect((await metaOf(`rec:${did}`))!.policies).toEqual({ found: true, policies: ["bsky-follows"] })
    })

    it("secondary records (putSecondary) carry no policies", async () => {
        const did = uniq()
        const ref = { did, collection: "app.bsky.actor.profile", rkey: "self" }
        await kvSnapshotStore(env).putSecondary(ref, entry(declarationCar(did, { keyPackage: keyPackage(2) })))
        const key = `rec:${ref.collection}/${ref.rkey}:${did}`
        expect((await metaOf(key))!.policies).toBeUndefined()
    })

    it("an entry stored without verifiedWith carries no policies", async () => {
        const did = uniq()
        await kvSnapshotStore(env).putRecord(
            did,
            entry(declarationCar(did, { keyPackage: keyPackage(2) }), { verifiedWith: null, cid: null })
        )
        expect((await metaOf(`rec:${did}`))!.policies).toBeUndefined()
    })
})

describe("reading policies back", () => {
    it("the record snapshot store's get returns the stored policies for the declaration", async () => {
        const did = uniq()
        await kvSnapshotStore(env).putRecord(did, entry(declarationCar(did, { keyPackage: keyPackage(2) })))
        const read = await kvRecordSnapshots(env).get(did, DECLARATION_COLLECTION_NSID, "self")
        expect(read!.policies).toEqual({ found: true, policies: ["open"] })
    })

    it("an entry stored without policies reads with policies absent, not undecodable", async () => {
        const did = uniq()
        await putV2Entry(env, `rec:${did}`, { rev: "r", observedAtMs: 1, verifiedWith: "k", cid: "c" })
        const read = await kvRecordSnapshots(env).get(did, DECLARATION_COLLECTION_NSID, "self")
        expect(read).not.toBeNull()
        expect("policies" in read!).toBe(false)
    })
})
