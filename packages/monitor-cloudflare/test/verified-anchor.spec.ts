/**
 * The monitor's verified answer to "what anchor does this DID declare?",
 * which is what may retire a relay registration.
 */
import { DECLARATION_COLLECTION_NSID, encodeOkpEd25519Key } from "@germ-network/atproto-pmr-core"
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { buildRepoCar, makeKey } from "../../core/test/fixtures/repo-car"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"
import { kvSnapshotStore } from "../src/snapshot-store"

const testEnv = env as unknown as MonitorEnv
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const x = new Uint8Array(32).fill(7)

let n = 0
const uniq = () => `did:plc:verified-anchor-${(n += 1)}`

function inObj<R>(did: string, fn: (obj: MonitorIngest) => R | Promise<R>): Promise<R> {
    const stub = testEnv.ingest.get(testEnv.ingest.idFromName(did))
    return runInDurableObject(stub, (obj) => fn(obj as MonitorIngest))
}

/** Stores a verified held declaration naming `x`, as ingest would. */
async function hold(
    did: string,
    currentKey: Uint8Array = Uint8Array.of(3, ...x),
    rowCid?: string
): Promise<void> {
    const path = `${DECLARATION_COLLECTION_NSID}/self`
    const { car, recordCids } = buildRepoCar({
        did,
        key: makeKey(),
        records: { [path]: { currentKey } },
    })
    const cid = recordCids[path]!
    await kvSnapshotStore(testEnv).putRecord(did, {
        rev: "3kaaaaaaaaaaa",
        car,
        observedAtMs: 1_000,
        source: "https://pds.example",
        signingKey: SIGNING_KEY,
        verifiedWith: SIGNING_KEY,
        cid,
    })
    await inObj(did, (obj) => obj.complete(did, "3kaaaaaaaaaaa", Date.now(), { cid: rowCid ?? cid, verifiedWith: SIGNING_KEY }))
}

describe("MonitorIngest.verifiedAnchorOf", () => {
    it("a held, verified declaration answers present with its anchor key", async () => {
        const did = uniq()
        await hold(did)
        const r = await inObj(did, (obj) => obj.verifiedAnchorOf(did))
        expect(r).toEqual({ state: "present", anchorKey: encodeOkpEd25519Key({ x }) })
    })

    it("a held declaration whose key field is unsupported answers unknown", async () => {
        const did = uniq()
        await hold(did, Uint8Array.of(2, ...x))
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "unknown" })
    })

    it("a snapshot that is not the record the verified row names answers unknown", async () => {
        const did = uniq()
        await hold(did, Uint8Array.of(3, ...x), "bafyreidifferentrecordcid")
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "unknown" })
    })

    it("the first sighting of an exclusion proof from a live repo answers absent", async () => {
        const did = uniq()
        await hold(did)
        await inObj(did, (obj) => obj.completeDeletion(did, Date.now(), false, false, "record"))
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "absent" })
    })

    it("a re-confirmed exclusion proof still answers absent", async () => {
        const did = uniq()
        await hold(did)
        await inObj(did, async (obj) => {
            await obj.completeDeletion(did, Date.now(), false, false, "record")
            await obj.markGoneReversible(did, "record")
        })
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "absent" })
    })

    it("a deactivated, taken-down or suspended repo answers unknown", async () => {
        const did = uniq()
        await hold(did)
        await inObj(did, async (obj) => {
            await obj.completeDeletion(did, Date.now(), false, false, "repo")
        })
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "unknown" })
    })

    it("a bare RecordNotFound or RepoNotFound answers unknown", async () => {
        const did = uniq()
        await hold(did)
        await inObj(did, async (obj) => {
            await obj.completeDeletion(did, Date.now(), false, false, "record")
            // An unproven answer replaces the verified one.
            await obj.markGoneReversible(did, "repo")
        })
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "unknown" })
    })

    it("a DID never verified answers unknown", async () => {
        const did = uniq()
        expect(await inObj(did, (obj) => obj.verifiedAnchorOf(did))).toEqual({ state: "unknown" })
    })
})
