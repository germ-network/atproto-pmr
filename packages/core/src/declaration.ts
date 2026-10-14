import { OkpEd25519Key, encodeOkpEd25519Key, parseOkpEd25519Key } from "./cose/key"
import { snapshotRecordReader, type RecordSnapshot } from "./snapshot-read"

/**
 * Declaration resolution, in two deliberately separate shapes.
 *
 * **`resolveDeclaration` / `resolveDeclarationWithRev`: the PDS, for the
 * owner's own DID** (registration, the declaration watch). DID → DID
 * document → PDS → `com.atproto.repo.getRecord`, as JSON, over TLS to the
 * authoritative host. The result is consumed by the relay and discarded, so
 * TLS to the PDS is the trust basis, and there is no cache: a direct fetch
 * per call keeps the work uniform across outcomes.
 *
 * **`snapshotDeclarationResolver`: a third party's CAR, for a sender's DID**
 * (pair-put admission). It verifies the key monitor's stored CAR against the
 * DID document's signing key and does not take the declaration from the
 * sender's PDS: an inline fetch there would tell the sender's PDS when the
 * sender sends, and the sender's PDS is the party whose claim is being
 * checked. Only a snapshot the monitor has let lapse is checked against the
 * PDS, for change alone. It returns the declaration record's CID alongside
 * the anchor key so the delivery hint can name exactly what was verified.
 */

export type DeclarationResolution =
    | { found: true; anchorKey: OkpEd25519Key }
    | {
          found: false
          reason: string
          /**
           * True only when the PDS was actually reached and it definitively
           * has no usable anchor key for this DID — a confirmed-gone record
           * or repo (`RecordNotFoundError`), a 200 with no `currentKey`, or a
           * `currentKey` present but unparseable/unsupported. Absent/false
           * means the failure was transient (resolution failed, the PDS was
           * unreachable, a timeout): "confirmed absent" and "cannot tell"
           * demand opposite handling, and the declaration watch MUST pause a
           * mailbox only on the former, never inferring absence from bare
           * unreachability (`spec/key-transparency.md`). The pair-put
           * admission path ignores this field and reads only `found`.
           */
          confirmed?: boolean
      }

/**
 * What pair-put admission needs: the anchor key AND the CID of the
 * declaration record it came from, so the delivery hint can name exactly the
 * declaration the relay verified against. Kept distinct from
 * `DeclarationResolution` so the PDS resolver cannot be wired into pair put.
 */
export type SenderDeclarationResolution =
    | { found: true; anchorKey: OkpEd25519Key; declarationCID: string }
    | { found: false; reason: string }

/** A third party's stored proof of a DID's declaration. */
export type DeclarationSnapshot = RecordSnapshot

export interface SnapshotDeclarationDeps {
    /** Null if none is held. A thrown error is a relay fault and propagates. */
    getSnapshot: (did: string) => Promise<DeclarationSnapshot | null>
    /** The DID document's `#atproto` multikey, or null. Never contacts the PDS. */
    resolveSigningKey: (did: string) => Promise<string | null>
    nowMs: () => number
    /** As `SnapshotRecordReaderDeps.fetchDirect`; called for the declaration's own path. */
    fetchDirect: (did: string, collection: string, rkey: string) => Promise<Uint8Array>
}

/**
 * Resolves a sender's declaration from a third-party snapshot (the monitor's
 * stored CAR), verified against the DID document's signing key, through the
 * generic `snapshotRecordReader` (which holds the 24 h rule and its memo).
 *
 * `SenderDeclarationResolution` is a distinct type from
 * `DeclarationResolution` to guard against accidental wiring of the PDS
 * resolver into pair put; it does not stop a wrapper from fabricating a
 * `declarationCID`.
 */
export function snapshotDeclarationResolver(
    deps: SnapshotDeclarationDeps
): (senderDID: string) => Promise<SenderDeclarationResolution> {
    const read = snapshotRecordReader({
        collection: DECLARATION_COLLECTION_NSID,
        rkey: "self",
        getSnapshot: deps.getSnapshot,
        resolveSigningKey: deps.resolveSigningKey,
        nowMs: deps.nowMs,
        fetchDirect: deps.fetchDirect,
    })
    return async (senderDID) => {
        const result = await read(senderDID)
        if (!result.found) return result

        const currentKey = (result.record as { currentKey?: unknown } | null)
            ?.currentKey
        if (!(currentKey instanceof Uint8Array)) {
            return { found: false, reason: "declaration has no currentKey bytes" }
        }
        try {
            const frozen = parseFrozenAnchorKeyField(currentKey)
            return {
                found: true,
                anchorKey: parseOkpEd25519Key(encodeOkpEd25519Key(frozen)),
                declarationCID: result.cid,
            }
        } catch (error) {
            return { found: false, reason: `malformed currentKey: ${String(error)}` }
        }
    }
}

/**
 * The germ declaration's anchor-key field: NOT COSE. One field —
 * an algorithm identifier byte followed by the raw key bytes — because this
 * is the frozen, published record format existing clients already parse
 * (spec/wire-api.md, "Key material"). Converted to `COSE_Key`-equivalent
 * shape on ingest, here, so nothing downstream of this function handles two
 * formats.
 *
 * The format is one algorithm-identifier byte followed by the raw key
 * bytes, with no length prefix and no enclosing structure. The identifiers
 * are assigned in this order:
 *
 *     0  AES-GCM-256
 *     1  ChaCha20-Poly1305
 *     2  Curve25519 key agreement  (X25519)
 *     3  Curve25519 signing        (Ed25519)
 *     4  HPKE encapsulation (Curve25519, SHA-256, ChaCha20-Poly1305)
 *     5  HMAC-SHA256
 *
 * The anchor key is a **signing** key, so byte **3** — not 2. Byte 2 is
 * key *agreement*, a different key entirely, and reading the wrong one
 * would silently accept or reject the wrong field. Byte 3 is the only case
 * this relay accepts today, per the PQ posture: launch classical,
 * algorithm-agile.
 */
const ANCHOR_KEY_ALG_CURVE25519_SIGNING = 3

/**
 * The declaration record's collection NSID. A protocol constant rather
 * than a deployment tunable, so it lives in code rather than in the
 * caller-supplied `PMRConfig`.
 */
export const DECLARATION_COLLECTION_NSID = "com.germnetwork.declaration"

/**
 * `com.atproto.repo.getRecord`'s terminal XRPC errors — a body that confirms
 * this DID's declaration is unobtainable rather than merely unreachable. The
 * same repo-level lifecycle set `fetch-record.ts` recognizes for the monitor's
 * `sync.getRecord`; here it lets the declaration watch tell a real
 * disappearance (pause) from a transient PDS blip (leave the mailbox alone).
 * A missing single record is answered by the reference PDS as a 200 with no
 * `currentKey`, handled below, so it need not appear here.
 */
const DECLARATION_TERMINAL_XRPC_ERRORS = [
    "RecordNotFound",
    "RepoNotFound",
    "RepoTakendown",
    "RepoSuspended",
    "RepoDeactivated",
] as const

/**
 * Atproto's JSON data-model bytes representation: `{"$bytes": "<base64>"}`,
 * standard alphabet (not base64url), and **unpadded** — the data model's
 * canonical form omits padding. `atob` requires padding, so it is restored
 * before decoding rather than assumed present.
 *
 * `response.json()` never produces a `Uint8Array` — JSON has no binary
 * type — so this is required, not optional, for any field read out of an
 * XRPC JSON response. An `instanceof Uint8Array` check here would silently
 * never match a real response.
 */
function decodeAtprotoBytes(value: unknown): Uint8Array {
    if (typeof value !== "object" || value === null || !("$bytes" in value)) {
        throw new Error('expected an atproto bytes object ({"$bytes": ...})')
    }
    const b64 = (value as { $bytes: unknown })["$bytes"]
    if (typeof b64 !== "string") {
        throw new Error("$bytes value must be a string")
    }
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

function parseFrozenAnchorKeyField(bytes: Uint8Array): OkpEd25519Key {
    if (bytes.byteLength !== 33) {
        throw new Error(
            "declaration: currentKey field must be 33 bytes (1 alg byte + 32 key bytes)"
        )
    }
    if (bytes[0] !== ANCHOR_KEY_ALG_CURVE25519_SIGNING) {
        throw new Error(
            `declaration: unsupported currentKey algorithm byte ${bytes[0]}`
        )
    }
    return { x: bytes.subarray(1) }
}

/**
 * The declaration record as this relay reads it. The anchor key field is
 * `currentKey` — note, not `anchorKey`. Every other field the record
 * carries is opaque to a relay and deliberately not modeled here.
 */
interface RawDeclarationRecord {
    currentKey?: unknown
}

function isRawDeclarationRecord(value: unknown): value is RawDeclarationRecord {
    return typeof value === "object" && value !== null
}

import {
    fetchLatestRev,
    guardedFetchJSON,
    RecordNotFoundError,
    resolvePDSEndpoint,
} from "./atproto-fetch"

/**
 * DID -> DID document -> PDS -> declaration, per atproto-pmr.md's own
 * algorithm. `fetchImpl` is injected so tests never make a real network
 * call — every call in this module's test suite is against a fixture. The
 * resolution and its SSRF guards live in `atproto-fetch.ts`, shared with
 * the key monitor.
 */
export async function resolveDeclaration(
    senderDID: string,
    fetchImpl: typeof fetch = fetch
): Promise<DeclarationResolution> {
    let pdsEndpoint: string
    try {
        ;({ endpoint: pdsEndpoint } = await resolvePDSEndpoint(senderDID, fetchImpl))
    } catch (e) {
        return pdsResolutionFailure(e)
    }
    return fetchDeclarationAt(pdsEndpoint, senderDID, fetchImpl)
}

/**
 * A PLC tombstone surfaces as `RecordNotFoundError` and is a confirmed
 * disappearance; any other resolution failure is transient.
 */
function pdsResolutionFailure(e: unknown): DeclarationResolution {
    return {
        found: false,
        reason: `PDS resolution failed: ${String(e)}`,
        confirmed: e instanceof RecordNotFoundError,
    }
}

/**
 * The declaration read + parse, given an already-resolved PDS endpoint. Split
 * from `resolveDeclaration` so the recheck path (`resolveDeclarationWithRev`)
 * can resolve the PDS once and then read both the declaration and the repo rev
 * from it.
 */
async function fetchDeclarationAt(
    pdsEndpoint: string,
    senderDID: string,
    fetchImpl: typeof fetch
): Promise<DeclarationResolution> {
    let record: unknown
    try {
        const url = new URL(`${pdsEndpoint}/xrpc/com.atproto.repo.getRecord`)
        url.searchParams.set("repo", senderDID)
        url.searchParams.set("collection", DECLARATION_COLLECTION_NSID)
        url.searchParams.set("rkey", "self")
        const body = (await guardedFetchJSON(url.toString(), fetchImpl, {
            terminalErrorNames: DECLARATION_TERMINAL_XRPC_ERRORS,
        })) as {
            value?: unknown
        }
        record = body.value
    } catch (e) {
        // The PDS answered with a terminal XRPC error (record/repo gone or
        // taken down) → confirmed; anything else (unreachable, timeout, a
        // bare non-ok) → transient, and the watch must not pause on it.
        return {
            found: false,
            reason: `declaration fetch failed: ${String(e)}`,
            confirmed: e instanceof RecordNotFoundError,
        }
    }

    if (!isRawDeclarationRecord(record) || record.currentKey === undefined) {
        // The PDS was reached and answered 200 with no `currentKey`: the key
        // is definitively absent, not merely unreachable.
        return {
            found: false,
            reason: "declaration: no currentKey present",
            confirmed: true,
        }
    }

    try {
        const rawBytes = decodeAtprotoBytes(record.currentKey)
        // The one conversion point: the declaration's frozen key field ->
        // the shape verifyPairPut consumes. Round-tripping through
        // encode/parse means this function's output always satisfies the
        // exact same invariants a COSE_Key parsed from the wire would —
        // nothing downstream ever has to know this key came from a
        // different format.
        const frozen = parseFrozenAnchorKeyField(rawBytes)
        return {
            found: true,
            anchorKey: parseOkpEd25519Key(encodeOkpEd25519Key(frozen)),
        }
    } catch (e) {
        // Reached, key field present but unparseable or an unsupported
        // algorithm (e.g. a rotation to a key type this relay does not
        // accept): the trusted key is definitively no longer usably present.
        return {
            found: false,
            reason: `declaration: malformed currentKey: ${String(e)}`,
            confirmed: true,
        }
    }
}

/**
 * A declaration resolution paired with the repo's rev at fetch time — for the
 * own-DID declaration WATCH (`watch.ts`), not the hot pair-put admission path.
 *
 * The watch needs a monotonic ordering token so a reordered/replayed recheck
 * (Cloudflare Queues are unordered + at-least-once) cannot clobber a fresher
 * pause decision with a staler one; `headRev` is that token
 * (`spec/storage-consistency.md`, "the last observed declaration revision";
 * `spec/trust-model.md`, monotonic-rev tracking). The DECISION is still made on
 * the `currentKey` value in `resolution` — the rev is used only for ordering and
 * rollback direction.
 *
 * `headRev` is `null` when the PDS could not be resolved, or when the record
 * resolved but `getLatestCommit` was unreachable. A caller that has a *present*
 * resolution but a `null` rev should treat the whole recheck as transient (and
 * retry) rather than unpause without a rev — an unpause must always carry a
 * monotonic rev for the watermark to be sound.
 */
export interface DeclarationWithRev {
    resolution: DeclarationResolution
    headRev: string | null
}

/**
 * `resolveDeclaration`, plus the repo rev, resolving the PDS once. The rev
 * fetch (`getLatestCommit`) is deliberately absent from `resolveDeclaration`
 * itself: that runs on every pair put, and the extra round trip belongs only on
 * the rarer recheck path (a declaration change, or the client's recency floor).
 */
export async function resolveDeclarationWithRev(
    senderDID: string,
    fetchImpl: typeof fetch = fetch
): Promise<DeclarationWithRev> {
    let pdsEndpoint: string
    try {
        ;({ endpoint: pdsEndpoint } = await resolvePDSEndpoint(senderDID, fetchImpl))
    } catch (e) {
        return { resolution: pdsResolutionFailure(e), headRev: null }
    }

    // getRecord before getLatestCommit: the TOCTOU is benign only this way — a
    // commit landing between the two reads can only make the rev look newer,
    // never manufacture a false "same rev, different value" (matches the
    // monitor's `fetch-record.ts`).
    const resolution = await fetchDeclarationAt(pdsEndpoint, senderDID, fetchImpl)
    let headRev: string | null = null
    try {
        headRev = await fetchLatestRev(pdsEndpoint, senderDID, fetchImpl)
    } catch {
        // Unreachable rev read is transient — the caller decides (a present
        // resolution with no rev is retried, never applied rev-less).
        headRev = null
    }
    return { resolution, headRev }
}

