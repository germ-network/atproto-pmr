/**
 * spec/vectors/request-mailboxes.json is the request-mailbox wire contract a
 * client tests itself against. A mismatch means the encoders changed the
 * wire, which is a contract change, not a reason to regenerate the vectors.
 */
import { readFileSync } from "node:fs"
import { sha256 } from "@noble/hashes/sha2.js"
import { describe, expect, it } from "vitest"
import { decodeCoseMap, encodeCose, type CoseValue } from "../src/cose/cbor"
import { messageEntryFields } from "../src/events"
import { messageIdFor } from "../src/message-id"
import { requestListingFields } from "../src/owner/endpoints"
import { cidToString } from "../src/repo-proof"
import type { MessageId, PairMailboxKey } from "../src/storage"

const file = JSON.parse(
    readFileSync(new URL("../../../spec/vectors/request-mailboxes.json", import.meta.url), "utf8")
)
const { locator, payloads } = file.inputs
const v = file.vectors
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const utf8 = (s: string) => new TextEncoder().encode(s)
type Row = { k: PairMailboxKey; id: MessageId[] }
const page = (rows: Row[], n: string | null) =>
    requestListingFields({ entries: rows.map((r) => ({ key: r.k, messageIds: r.id })), nextCursor: n })

describe("request-mailbox wire vectors", () => {
    it("derives every listed id from the sender DID and payload", () => {
        const [alice, bob] = v.listing.rows as Row[]
        expect(alice!.id).toEqual(["a1", "a2", "a3"].map((p) => messageIdFor({ locator, key: alice!.k }, utf8(payloads[p]))))
        expect(bob!.id).toEqual([messageIdFor({ locator, key: bob!.k }, utf8(payloads.b1))])
    })

    it.each(["listing", "listingPaged", "listingEmpty"])("encodes the %s page", (name) => {
        expect(hex(encodeCose(page(v[name].rows, v[name].n)))).toBe(v[name].cbor)
    })

    it("encodes the drop ack as {a: [{k, id}]} with no g", () => {
        const acks = v.dropAck.acks.map((a: Row & { id: string }) => new Map<string, CoseValue>([["k", a.k], ["id", a.id]]))
        expect(hex(encodeCose(new Map<string, CoseValue>([["a", acks]])))).toBe(v.dropAck.cbor)
        const decoded = decodeCoseMap(Buffer.from(v.dropAck.cbor, "hex"))
        expect((decoded.get("a") as Map<string, CoseValue>[])[0]!.has("g")).toBe(false)
    })

    it("gives every dc as a CIDv1 dag-cbor sha2-256 in multibase base32", () => {
        const dcs = Object.values(v).flatMap((x) => ((x as { dc?: string }).dc === undefined ? [] : [(x as { dc: string }).dc]))
        expect(dcs.length).toBeGreaterThan(0)
        for (const dc of dcs) expect(dc).toMatch(/^bafyrei[a-z2-7]{52}$/)
        const digest = sha256(utf8(file.inputs.declarationBlockUtf8))
        expect(v.fetchOneHit.dc).toBe(cidToString(new Uint8Array([0x01, 0x71, 0x12, 0x20, ...digest])))
    })

    it("encodes a fetched request entry in the catch-up entry shape", () => {
        const f = v.fetchOneHit
        const fields = messageEntryFields(f.k, {
            messageId: f.id,
            byteLength: utf8(f.m).byteLength,
            hint: { senderDID: f.sd, declarationCID: f.dc },
            pairGeneration: f.g,
        }, utf8(f.m))
        expect(hex(encodeCose(fields))).toBe(f.cbor)
    })
})
