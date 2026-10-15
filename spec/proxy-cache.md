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
against the DID's PDS for change, comparing the record's CID only, before a
**relay** relies on it for a pair put: if the PDS cannot be read the older
snapshot stands, and if the record changed or is gone the put is refused until
the cache catches up (the rule in
[trust-model P5](trust-model.md#p5--sender-verification)).

A **device read** does not wait for that check. A lapsed declaration is served
as held, and the read asks the monitor to re-check it afterwards: a re-check
request only moves a DID that is already due toward the front of the monitor's
refresh queue, never makes one due, and takes at most a quarter of a batch, so
anonymous reads cannot pin failing sources at its head. The check against the
PDS is the monitor's, off the response path. The pair-put rule is unchanged.

This carries the P5 caveat with it, in a smaller form. The re-check makes the
monitor read that DID's PDS, so the PDS learns that someone is interested in
it, though not who or when, and a burst of reads costs one request. The
privacy benefit of the proxy does not extend to a record whose snapshot has to
be re-confirmed this way. A summary index also notes a held declaration past
24 hours, as an operational alarm that the monitor has fallen behind, and never
requests a re-check, so one owner's sync does not fan out to their contacts'
PDSes.

## Which DID directory a device queries

- **`did:plc`** — a device may query the PLC directory directly by default.
  A user setting routes PLC queries through the PMR instead.
- **`did:web`** — a device does not query a `did:web` host directly, because
  a direct read reaches the identity's own host. The PMR proxies `did:web`
  documents.

## What is built, and what is not

| element | status |
|---|---|
| A monitor's record snapshot, kept current by Jetstream and backfilled by direct query of the PDS | **built** — [key transparency](key-transparency.md#keeping-the-snapshot-current) (under the `everyone` policy, every DID that carries the declaration collection, not only the DIDs one PMR serves; under `registered`, only the DIDs on the allow list below) |
| The monitor's periodic re-confirmation of held snapshots | **built** |
| The monitor's **interest policy**: an allow list of DIDs it keeps records for, `registered` (the default: registered users and, once follow edges are written, the DIDs they follow) or `everyone` (every declaration holder), set by `INTEREST_POLICY` | **built** — `registered` needs a `pmrDirectory` binding, and only `everyone` runs the relay backfill and takes in declaration commits for DIDs it does not already follow. DIDs join and leave the list with an epoch check, so nothing is stored for a DID that left while a fetch was in flight; under `registered` the declaration socket ignores commits outside it |
| The monitor's **profile snapshot**: the records named in `MONITOR_COLLECTIONS` (for example `app.bsky.actor.profile/self`; none when unset), verified and kept quietly beside the declaration for every DID in the allow list | **built** — no digest-window entry and no push. A holder's profile is head-checked hourly with its declaration; a DID that holds no declaration (a followee) is checked every 24 hours (`REFRESH_NONHOLDER_STALE_AFTER_MS`), with live profile events from the follow/profile stream keeping it current in between |
| The monitor's **follow-edge index**: who each graph owner follows, in D1, with the follower counts the interest policy needs | **built** — an owner is a registered user under `registered`, a declaration holder under `everyone`. Live follow events keep it current; an owner listing (one verified `getRepo`, or `listRecords` pages for a repo past the walk's caps) writes it in full. A graph is served only after its owner listing completes; until then the read surface answers "not served" |
| The monitor's **block index**: `app.bsky.graph.block` records, in D1, never published | **built** — every block of a served graph's owner, and a non-owner in interest's blocks of registered DIDs. Live block events ride the follow socket; listings read blocks with the follows, from the same verified `getRepo` (each collection under its own cap) or by `listRecords` pages. A DID's block rows are pruned with its follows when it leaves interest or its graph stops being served. Block lists have no public projection and no public route: an owner reads only their own, through the authenticated [summary](wire-api.md#summary), which the relay fills from the monitor over its ingest binding; other DIDs' blocks only answer whether one DID blocks another |
| The monitor's **graph projector**: the public `graph:<did>` projections, one per served graph | **built** — the alarm tails the edge index's change log, re-projecting each served graph a row names and deleting the projection of one no longer served; it rebuilds when its cursor falls behind the log's retention. Servedness is the standing last mirrored to the index, so a graph the index does not yet serve is never projected as empty |
| The monitor's **re-check queue**: a device read of a declaration past the 24-hour rule asks the monitor to refresh that DID | **built** — a request only moves a DID that is already due toward the front (at most a quarter of a batch), never makes one due, and expires after a day |
| **Mutual hints**: for each non-owner in interest, its follows of registered users, from `listRecords` | **built** — under `registered`, a followee's follows of a registered user are the hint that the followee follows them back |
| **Mixed provenance** of edges | **built** — rows from a verified `getRepo` listing are proven under the owner's signing key; paged-owner, mutual-hint and live rows are not. Every edge is a hint a device verifies for itself |
| A verified read of one record from a snapshot, generic over collection and rkey, with the 24-hour rule | **built** — used on the pair-put path and exposed to devices by the [device read API](wire-api.md#device-reads--records-graph-and-summary) |
| The `sd` + `dc` hint on delivered messages | **built** |
| The monitor's community-view fetch (`GET /records/{did}`) | **specified; store built** — `kvSnapshotStore` holds the record, the route itself is the deploying Worker's |
| Pushing the **owner's own** declaration change to its device | **built** — the monitor's own-DID web push, not the events socket |
| A cache of DID documents | **built** — a monitor stores and publishes a document for each DID it watches ([key transparency](key-transparency.md#the-stored-did-document)); a relay reading it is a deployment step, and the `#atproto` signing key it caches meanwhile is re-fetched after ten minutes |
| A `did:plc` **operation log** per watched DID, for a device to verify | **built** — the stream extends a held log (each appended operation's signature is checked), a gap or a fork owes a fetch of the directory's audit log, a fetched log is verified before it is kept and published as `plclog:<did>`, and a stored log confirms the document it renders ([wire API](wire-api.md#did-documents)) |
| PLC export stream ingest | **built** — one stream, opt-in by `PLC_EXPORT_STREAM_URL`, feeds both the signing-key cache and the stored documents ([signing-key cache](key-transparency.md#the-signing-key-cache), [stored documents](key-transparency.md#the-stored-did-document)) |
| Pushing **counterpart** record changes to devices | **not yet built** |
| A device-facing read API, and so the 24-hour rule for device reads | **built** — public record and graph reads and the owner's summary ([wire API](wire-api.md#device-reads--records-graph-and-summary)); routes are mounted by the deploying Worker |
| `did:web` document proxying | **built, as a hint** — the device reads the monitor's stored document from `/pmr/v1/did/{did}`, which it cannot verify and may confirm with the host |
| The user setting that routes PLC queries through the PMR | **not yet built** |

## Sizing the follow-edge index

Limits at the defaults, per two-minute alarm (720 a day):

- **D1 drain.** Listings may take 400 of the alarm's 1,000 statements (`FOLLOW_LISTING_STATEMENT_RESERVE`), about 2,450 edges (follows and blocks together), or 1.76 million a day.
- **`getRepo`.** At most 4 fetches an alarm, one at a time (`FOLLOW_BACKFILL_REPOS`), so 2,880 a day or 20,160 a week.
- **`listRecords`.** At most 200 pages an alarm. A mutual listing reads at least two pages (follows, then blocks) and costs 4 to 10 statements, so 40 to 100 finish per alarm: 29,000 to 72,000 a day.
- **Latency.** Listings run one at a time, so throughput is the lower of the statement and the latency bound.

**Per tenant under `registered`**, for each registered user:

- *Once, on registration:* one `getRepo` (median 3 MB, its blocks included), about 700 followees each with a declaration and a profile fetch, about 700 mutual listings of two pages each, one of follows and one of blocks (about 140 MB of `listRecords` for the follows), and 2,000 to 6,000 D1 statements. A user's own blocks are typically tens to hundreds, one row each; accounts that follow block-list tooling can hold tens of thousands. The owner listing is served within an alarm or two. The mutual hints complete in about half an hour.
- *Every `FOLLOW_RELIST_AFTER_MS` (7 days):* the same listings again, spread across the week by a top-up that fills only the capacity joins and registrations leave.
- *Tenant ceiling.* The weekly mutual re-list needs about 700 listings per registered user once followees are deduplicated across tenants. At 40 to 100 listings per alarm (201,600 to 504,000 a week) the ceiling is roughly 290 to 720 registered users. Past it, joins and registrations are unaffected because they sort ahead of re-lists; only the effective re-list interval grows. Raising `FOLLOW_RELIST_AFTER_MS` to 30 days lifts the ceiling about fourfold, since the live stream keeps hints current and a gap re-list covers outages.

**Private deployment under `everyone`:** about 1,750 holders with 1.4 million edges (about 200 MB in D1). The first wave is about 14 GB of `getRepo`, bound by the D1 drain at roughly 19 hours; the weekly re-list repeats it, spread by the top-up. Holders whose repos are deactivated or taken down are not retried.

An owner past `FOLLOW_MAX_REPO_BYTES` (32 MiB), `MAX_FOLLOWS` follow records (20,000), `MAX_BLOCKS` block records (20,000) or three consecutive timeouts is listed by `listRecords` pages instead, with unverified rows, and stays on pages: an owner with more blocks than `MAX_BLOCKS` is listed by pages for follows as well. A mutual listing stops reading a collection at its cap and keeps what it has.

**Blocks, per summary read.** Each owner summary read costs the singleton ingest object one D1 read of that owner's blocks (a batch of two statements) over the cross-Worker binding, outside the alarm's statement budget, so polling devices add read load in proportion to their poll rate. A failed read answers the summary `503` rather than an empty list.

**Deploy contract for blocks.** Apply migration `0002_blocks.sql` before deploying; the follow socket's URL gains the block collection once; `MAX_BLOCKS` is optional. The relay's summary needs `blocks: monitorOwnBlocks(env)` and so a bound `MONITOR_INGEST` and `MONITOR_INGEST_NAME`: without them every summary read answers `503`, where a relay without the monitor served the summary before. Relay state stored by this version holds a block-list part that an older relay cannot read, so a rollback fails summary reads until those states age out.

**Known gap.** A newly registered user's existing inbound blocks from in-interest DIDs that are not their followees reach the index only at each blocker's next stale re-list (`FOLLOW_RELIST_AFTER_MS`); their followees' blocks are caught by the followee listings registration already queues.
