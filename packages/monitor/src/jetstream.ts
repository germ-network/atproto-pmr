/**
 * The wake signal: Jetstream's event envelope, decoded defensively.
 *
 * Nothing decoded here is trusted. Jetstream serves JSON with no MST proof,
 * so an event says only "look at this DID again" — the record that enters
 * the snapshot is fetched and verified separately
 * (`spec/key-transparency.md`). A hostile feed can therefore cause a wasted
 * fetch or withhold an event, and nothing else.
 *
 * Field names verified against `jetstream.us-west.bsky.network` on
 * 2026-08-14; the decoder tolerates unknown fields and unknown kinds
 * because the wire format is someone else's and still moving.
 */

/** Kinds a monitor acts on. Others are ignored rather than rejected. */
export type EventKind = "commit" | "identity" | "account" | "sync"

export type CommitOperation = "create" | "update" | "delete"

/**
 * A commit on a watched collection.
 *
 * `rev` and `cid` are what make a duplicate cheap: a re-delivered event —
 * routine after a reconnect, since resume rewinds to a segment boundary —
 * is recognized against the index without fetching anything.
 */
export interface CommitEvent {
    kind: "commit"
    did: string
    collection: string
    rkey: string
    operation: CommitOperation
    rev: string
    cid: string | null
    seq: number | null
    timeMs: number | null
}

/**
 * An identity or account change. These **ignore the collection filter** and
 * arrive for every DID on the network, so a monitor drops the ones outside
 * its snapshot. For a DID inside it, an identity event is signal: the DID
 * document's signing key may have rotated, which changes what that DID's
 * record verifies against.
 */
export interface IdentityEvent {
    kind: "identity" | "account" | "sync"
    did: string
    seq: number | null
    timeMs: number | null
}

export type MonitorEvent = CommitEvent | IdentityEvent

function str(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** Milliseconds from either the v2 ISO `time` or a v1 `time_us`. */
function timeMs(payload: Record<string, unknown>): number | null {
    const us = num(payload.time_us)
    if (us !== null) return us / 1000
    const iso = str(payload.time)
    if (iso === null) return null
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? null : ms
}

function kindOf(payload: Record<string, unknown>): EventKind | null {
    // v1 says `kind`; v2 says `$type: "…#commit"`.
    const k = str(payload.kind)
    if (k === "commit" || k === "identity" || k === "account" || k === "sync") {
        return k
    }
    const t = str(payload.$type)
    if (t === null) return null
    const tail = t.slice(t.indexOf("#") + 1)
    return tail === "commit" || tail === "identity" || tail === "account" || tail === "sync"
        ? tail
        : null
}

/**
 * Decode one frame. Returns `null` for anything unrecognized — a malformed
 * frame MUST NOT break the stream, since the cursor is what guarantees
 * coverage and a thrown decode would strand it.
 */
export function decodeEvent(raw: string): MonitorEvent | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof parsed !== "object" || parsed === null) return null

    const outer = parsed as Record<string, unknown>
    const inner = outer.payload
    const payload = (
        typeof inner === "object" && inner !== null ? inner : outer
    ) as Record<string, unknown>

    const kind = kindOf(payload)
    const did = str(payload.did)
    if (kind === null || did === null) return null

    const seq = num(payload.seq)
    const at = timeMs(payload)

    if (kind !== "commit") return { kind, did, seq, timeMs: at }

    // v1 nests commit fields; v2 flattens them onto the payload.
    const c = (
        typeof payload.commit === "object" && payload.commit !== null
            ? payload.commit
            : payload
    ) as Record<string, unknown>

    const collection = str(c.collection)
    const rev = str(c.rev)
    const rkey = str(c.rkey)
    if (collection === null || rev === null || rkey === null) return null

    const op = str(c.operation)
    return {
        kind: "commit",
        did,
        collection,
        rkey,
        operation:
            op === "create" || op === "update" || op === "delete" ? op : "update",
        rev,
        cid: str(c.cid),
        seq,
        timeMs: at,
    }
}
