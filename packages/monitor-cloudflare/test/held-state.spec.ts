/**
 * The ingest object keeps each held declaration's writer state on its index
 * row, written in the transaction that indexes the rev, so it never has to
 * read the snapshot store back.
 */
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { VerifiedDeclarationWrite } from "@germ-network/atproto-pmr-monitor"
import type { MonitorEnv } from "../src/env"
import type { MonitorIngest } from "../src/ingest-object"

const testEnv = env as unknown as MonitorEnv
const KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"
const REV = "3kaaaaaaaaaaa"

let n = 0
const uniq = () => `did:plc:held-state-${(n += 1)}`

function inObj<R>(did: string, fn: (obj: MonitorIngest) => R | Promise<R>): Promise<R> {
    const stub = testEnv.ingest.get(testEnv.ingest.idFromName(did))
    return runInDurableObject(stub, (obj) => fn(obj as MonitorIngest))
}

function written(over: Partial<VerifiedDeclarationWrite> = {}): VerifiedDeclarationWrite {
    return {
        cid: "bafyreirecord",
        verifiedWith: KEY,
        commitCid: "bafyreicommit",
        anchorKey: Uint8Array.of(3, 1, 2, 255),
        messagingKeyFingerprint: "ab".repeat(32),
        messagingKeyFirstSeenAtMs: 1_700_000_000_000,
        ...over,
    }
}

describe("held declaration state", () => {
    it("complete records commitCid, anchorKey, messaging key fingerprint and first-seen with the rev", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toEqual({
            rev: REV,
            cid: "bafyreirecord",
            verifiedWith: KEY,
            commitCid: "bafyreicommit",
            anchorKey: Uint8Array.of(3, 1, 2, 255),
            messagingKeyFingerprint: "ab".repeat(32),
            messagingKeyFirstSeenAtMs: 1_700_000_000_000,
            seenKey: null,
        })
    })

    it("completeQuietly records the same writer state as complete", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.completeQuietly(did, REV, 5_000, written({ anchorKey: null })))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toMatchObject({
            rev: REV,
            commitCid: "bafyreicommit",
            anchorKey: null,
            messagingKeyFingerprint: "ab".repeat(32),
            messagingKeyFirstSeenAtMs: 1_700_000_000_000,
        })
    })

    it("heldDeclarationOf answers null for a DID whose declaration is not held", async () => {
        const did = uniq()
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toBeNull()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => obj.markGoneReversible(did, "record"))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toBeNull()
    })

    it("heldDeclarationOf answers null after completeDeletion", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => obj.completeDeletion(did, 6_000, true))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toBeNull()
    })

    it("recordSeenKey sets seenKey without changing rev, cid or the snapshot store", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => obj.recordSeenKey(did, KEY))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toMatchObject({
            rev: REV,
            cid: "bafyreirecord",
            seenKey: KEY,
        })
        expect(await testEnv.records.list({ prefix: `rec:${did}` })).toMatchObject({ keys: [] })
    })

    it("a new complete keeps the recorded seenKey", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => obj.recordSeenKey(did, KEY))
        await inObj(did, (obj) =>
            obj.complete(
                did,
                "3kbbbbbbbbbbb",
                6_000,
                written({
                    cid: "bafyreinew",
                    commitCid: "bafyreicommit2",
                    anchorKey: Uint8Array.of(9, 0),
                    messagingKeyFingerprint: "cd".repeat(32),
                    messagingKeyFirstSeenAtMs: 1_800_000_000_000,
                })
            )
        )
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toEqual({
            rev: "3kbbbbbbbbbbb",
            cid: "bafyreinew",
            verifiedWith: KEY,
            commitCid: "bafyreicommit2",
            anchorKey: Uint8Array.of(9, 0),
            messagingKeyFingerprint: "cd".repeat(32),
            messagingKeyFirstSeenAtMs: 1_800_000_000_000,
            seenKey: KEY,
        })
    })

    it("a settle under a new signing key clears the seen key, so a return to an earlier seen key is pushed", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => obj.recordSeenKey(did, "zOtherKey"))
        await inObj(did, (obj) => obj.complete(did, "3kbbbbbbbbbbb", 6_000, written({ verifiedWith: "zNewKey" })))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toMatchObject({
            verifiedWith: "zNewKey",
            seenKey: null,
        })
    })

    it("the schema upgrade adds the writer-state columns to a records table that lacks them", async () => {
        const did = uniq()
        await inObj(did, (obj) => obj.complete(did, REV, 5_000, written()))
        await inObj(did, (obj) => (obj as unknown as { ensureRecordsWriterState(): void }).ensureRecordsWriterState())
        await inObj(did, (obj) => {
            const sql = (obj as unknown as { db: { sql: SqlStorage } }).db.sql
            for (const column of [
                "commit_cid",
                "anchor_key",
                "messaging_key_fingerprint",
                "messaging_key_first_seen_at",
                "seen_key",
            ]) {
                sql.exec(`ALTER TABLE records DROP COLUMN ${column}`)
            }
        })
        // Re-running the constructor's migration is what a deploy does.
        await inObj(did, (obj) => (obj as unknown as { ensureRecordsWriterState(): void }).ensureRecordsWriterState())
        await inObj(did, (obj) => obj.complete(did, "3kbbbbbbbbbbb", 6_000, written()))
        expect(await inObj(did, (obj) => obj.heldDeclarationOf(did))).toMatchObject({
            rev: "3kbbbbbbbbbbb",
            commitCid: "bafyreicommit",
        })
    })
})
