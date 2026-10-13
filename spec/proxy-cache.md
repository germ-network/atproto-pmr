# The PMR as a proxy cache of atproto state

## Intended model — not yet built

_Where the specification so far has a relay read atproto state only through
the key monitor, this document describes the intended direction: a PMR that
keeps a verified cache of the atproto records and DID documents of the DIDs
it serves, and answers its devices' reads of them. It is a statement of
intent, not a contract. Each element below is marked **built** (present in
the current implementation) or **not yet built**, and nothing marked
not-yet-built is a requirement on a conforming relay today._

## The model

A PMR holds, for the DIDs it serves, a cache of:

- **atproto records, as CAR** — kept current by the Jetstream firehose, and
  backfilled by a direct query of the DID's PDS;
- **DID documents** — kept current by the PLC export stream (for `did:plc`),
  and backfilled by a direct query of the directory.

Devices are **pushed** changes to counterpart records over the events socket
and the catch-up endpoint, and **backfill by direct query**, normally to the
PMR rather than to the PDS or the directory.

The cache is only worth keeping if a device can use it without trusting it.
It therefore stays a **cache of signed things**: records are CAR, verified
against the DID document, and DID documents are checked against PLC. This is
the same posture the rest of the specification takes toward a monitor —
[as untrusted as any relay](key-transparency.md#the-record-fetch), for the
authenticity reasons in
[trust-model P2](trust-model.md#p2--relayed-repo-records-are-car) — and it is why [the hint](trust-model.md#p8--the-relays-verdict-is-a-hint) is
a freshness cue and never evidence.

## "Trusted proxy" means trusted for privacy, not for content

Routing a device's reads through its PMR is a privacy measure: the PDS and a
`did:web` host do not learn which DIDs a device is looking at, or when. That
is the whole of the trust. A device still verifies every CAR against the DID
document itself, and never takes the PMR's word for a record's content or for
a key. A PMR that served a wrong record would be caught by that verification,
the same as any other source.

## Reads and the 24-hour rule

A snapshot the cache has not been able to confirm for 24 hours is checked
against the DID's PDS for change before it is served, comparing the record's
CID only; if the PDS cannot be read the older snapshot stands, and if the
record changed or is gone the read is refused until the cache catches up (the
rule in [trust-model P5](trust-model.md#p5--sender-verification)). The model
applies it to **every** read of a declaration, whichever party asked.

This carries the P5 caveat with it. A device-triggered read past 24 hours
causes a PMR→PDS read: the same bounded exception, with the same memo bound
(an answer is remembered for ten minutes), and with the same cost — that DID's
PDS learns that someone is interested in it. The privacy benefit of the proxy
does not extend to a read that has to fall through to the PDS.

## Which DID directory a device queries

- **`did:plc`** — a device may query the PLC directory directly by default.
  A user setting routes PLC queries through the PMR instead.
- **`did:web`** — a device does not query a `did:web` host directly, because
  a direct read reaches the identity's own host. The PMR proxies `did:web`
  documents.

## What is built, and what is not

| element | status |
|---|---|
| A monitor's record snapshot, kept current by Jetstream and backfilled by direct query of the PDS | **built** — [key transparency](key-transparency.md#keeping-the-snapshot-current) (covering every DID that carries the declaration collection, not only the DIDs one PMR serves) |
| The monitor's periodic re-confirmation of held snapshots | **built** |
| A verified read of one record from a snapshot, generic over collection and rkey, with the 24-hour rule | **built** — used on the pair-put path only; exposed on no endpoint |
| The `sd` + `dc` hint on delivered messages | **built** |
| The monitor's community-view fetch (`GET /records/{did}`) | **specified; store built** — `kvSnapshotStore` holds the record, the route itself is the deploying Worker's |
| Pushing the **owner's own** declaration change to its device | **built** — the monitor's own-DID web push, not the events socket |
| A cache of DID documents | **not yet built** — only the `#atproto` signing key is cached, re-fetched after ten minutes |
| PLC export stream ingest | **not yet built** |
| Pushing **counterpart** record changes to devices | **not yet built** |
| A device-facing read API, and so the 24-hour rule for device reads | **not yet built** |
| `did:web` document proxying | **not yet built** |
| The user setting that routes PLC queries through the PMR | **not yet built** |
