/**
 * Decoding the wake signal.
 *
 * The v2 fixtures are verbatim frames captured from
 * `jetstream.us-west.bsky.network` on 2026-08-14, trimmed only in the
 * record body. The point of decoding defensively is that this format is
 * someone else's and still moving: a frame we cannot read must be skipped,
 * never thrown, because a thrown decode strands the cursor and the cursor
 * is what guarantees coverage.
 */
import { describe, expect, it } from "vitest"
import { decodeEvent } from "../src/jetstream"

const V2_COMMIT = JSON.stringify({
    $type: "message",
    payload: {
        $type: "network.bsky.jetstream.subscribeEvents#commit",
        cid: "bafyreief4pxgwvuhvx2e7ivkstx57xjicssyfppkoy2fbnaehhhwafdgpe",
        collection: "com.germnetwork.declaration",
        did: "did:plc:kucq32fcr4qdfehbzrinpxn5",
        operation: "create",
        record: { $type: "com.germnetwork.declaration" },
        rev: "3mszqbq6s3y2k",
        rkey: "self",
        seq: 24702643754,
        time: "2026-08-14T08:25:16.763191Z",
    },
})

const V1_COMMIT = JSON.stringify({
    did: "did:plc:kucq32fcr4qdfehbzrinpxn5",
    time_us: 1786695916763191,
    kind: "commit",
    commit: {
        rev: "3mszqbq6s3y2k",
        operation: "update",
        collection: "com.germnetwork.declaration",
        rkey: "self",
        cid: "bafyreief4pxgwvuhvx2e7ivkstx57xjicssyfppkoy2fbnaehhhwafdgpe",
    },
})

describe("decodeEvent", () => {
    it("reads a v2 commit, unwrapping the envelope", () => {
        const e = decodeEvent(V2_COMMIT)
        expect(e).toMatchObject({
            kind: "commit",
            did: "did:plc:kucq32fcr4qdfehbzrinpxn5",
            collection: "com.germnetwork.declaration",
            rev: "3mszqbq6s3y2k",
            rkey: "self",
            operation: "create",
            seq: 24702643754,
        })
    })

    it("reads a v1 commit, whose fields are nested and whose clock is µs", () => {
        // Both shapes decode to one type so ingest never branches on version.
        const e = decodeEvent(V1_COMMIT)
        expect(e).toMatchObject({ kind: "commit", rev: "3mszqbq6s3y2k" })
        expect(e?.timeMs).toBe(1786695916763.191)
    })

    it("carries rev and cid, which is what makes a duplicate cheap", () => {
        // A reconnect replays a segment, so most events after one are
        // already applied. Suppressing them costs an index read only
        // because the wake signal itself names the rev.
        const e = decodeEvent(V2_COMMIT)
        expect(e).toMatchObject({ kind: "commit" })
        if (e?.kind !== "commit") throw new Error("expected a commit")
        expect(e.rev).not.toBe("")
        expect(e.cid).not.toBeNull()
    })

    it("reads identity events, which arrive for every DID", () => {
        const e = decodeEvent(
            JSON.stringify({
                payload: {
                    $type: "network.bsky.jetstream.subscribeEvents#identity",
                    did: "did:plc:someone",
                    seq: 1,
                    time: "2026-08-14T08:25:16.763191Z",
                },
            })
        )
        expect(e).toMatchObject({ kind: "identity", did: "did:plc:someone" })
    })

    it("returns null rather than throwing on anything unreadable", () => {
        for (const bad of [
            "",
            "not json",
            "null",
            "[]",
            JSON.stringify({ payload: { $type: "…#commit" } }), // no did
            JSON.stringify({ payload: { $type: "…#commit", did: "did:plc:x" } }), // no rev
            JSON.stringify({ payload: { $type: "…#future", did: "did:plc:x" } }),
        ]) {
            expect(decodeEvent(bad)).toBeNull()
        }
    })

    it("defaults an unrecognized operation rather than dropping the event", () => {
        // The DID still needs looking at; the operation is a hint, and the
        // authoritative fetch is what decides what is true.
        const e = decodeEvent(
            JSON.stringify({
                payload: {
                    $type: "…#commit",
                    did: "did:plc:x",
                    collection: "com.germnetwork.declaration",
                    rev: "3m",
                    rkey: "self",
                    operation: "something-new",
                },
            })
        )
        expect(e).toMatchObject({ kind: "commit", operation: "update" })
    })
})
