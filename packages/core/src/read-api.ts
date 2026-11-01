/**
 * The device read API's response bodies (`spec/key-transparency.md`, "Reads and
 * the 24-hour rule"). A record is served as its proof CAR, never as a parsed
 * value: the PMR is trusted for privacy, not for content, so the device
 * verifies what it is given.
 *
 * On the wire each body is deterministic CBOR with the short keys below,
 * matching every other body in this protocol (`spec/wire-api.md`,
 * "Deterministic CBOR"). The key tables are typed against their response, so
 * a field added to a response does not compile until it has a key. A decoder
 * ignores keys it does not know, so a field can be added without breaking
 * older clients.
 */

/**
 * Why a record read found nothing:
 * - `not-watched` — this PMR does not snapshot that collection/rkey.
 * - `not-held` — no snapshot is held for the DID.
 * - `unverifiable` — a snapshot is held but ingest did not verify it against
 *   the DID document's signing key.
 *
 * A snapshot past the 24-hour rule is still served; the check against the
 * PDS runs afterwards and the response never waits on it.
 */
export type RecordReadMiss = "not-watched" | "not-held" | "unverifiable"

export type RecordReadResponse =
    | {
          found: true
          /** The single-record proof CAR, byte for byte as held. */
          car: Uint8Array
          /** The signed commit's `rev`; a hint the device re-derives from `car`. */
          rev: string
          /**
           * The record's CID (CIDv1, dag-cbor, sha2-256, base32 lower); a hint
           * the device re-derives from `car`.
           */
          cid: string
          freshAtMs: number
      }
    | { found: false; code: RecordReadMiss; reason: string }

/**
 * One of the owner's own blocks, carried only by the owner's summary. `rkey`
 * locates the block record in the owner's repo, so the device can verify it.
 */
export interface OwnBlock {
    /** The blocked DID. */
    did: string
    rkey: string
}

type FieldsOf<T> = T extends unknown ? keyof T : never
type WireKeys<T> = { readonly [K in FieldsOf<T>]: string }

export const RECORD_READ_KEYS = {
    found: "f",
    car: "c",
    rev: "r",
    cid: "i",
    freshAtMs: "t",
    code: "e",
    reason: "m",
} as const satisfies WireKeys<RecordReadResponse>

export const OWN_BLOCK_KEYS = {
    did: "d",
    rkey: "k",
} as const satisfies WireKeys<OwnBlock>

