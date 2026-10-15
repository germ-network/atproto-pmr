# The PMR as a messaging appview

A PMR can offload the role of computing network state, serving as an appview
for messaging. In this role it provides

* immediate and efficient updates to keys and DID documents (already covered by the key monitor)
* efficient updates of bluesky profiles (display name and profile picture)
* efficient updates of who the user can message

This appview also allows the atproto PMR to efficiently adjudicate which
DID to DID messages it may accept.

The data the PMR appview caches is public in principle. Records and DID documents are
public atproto state. So is the fact that a user is hosted on a given PMR,
since a relay is reached through the user's DID document
([P9](trust-model.md#p9--user-controlled-discovery)). A PMR's unauthenticated reads
exist so the PMR **cannot identify the caller**, not to keep the data secret.
Each one gives every caller the same answer and authenticates no one.
Authentication is for per-user state, such as a user's own catch-up summary
and its diff baseline, never for protecting public data. This is about reads
of cached atproto state. The mailbox closure rules
([P3](trust-model.md#p3--closure)) protect mailbox state and are unchanged.

Two consequences for the read surface:

- **Cheap to serve.** Public reads come from stored bytes, with no per-read
  verification and no per-caller work. Anything that would cost the host
  more than it saves its users is left out.
- **Computed results, not raw material.** A device consumes what it acts on:
  its user's own blocks, and for each contact whether the user can message
  them, plus the contact's declaration and profile. The PMR does not publish
  raw follow or block lists. This is not because they are secret. Devices
  don't consume them, and keeping them projected for publication costs the
  host writes.

## What the appview computes

- **Whether the user can message a DID.** A verdict per sender and recipient,
  computed from the recipient's declared policy, their follows and their
  blocks: public, for any pair, and in the owner's summary for each of the
  owner's contacts. **Not yet built.**
- **The user's own blocks.** The owner's block list, in the owner's
  authenticated summary, sent whole when it changes. **Built.**
- **Profiles.** Each contact's profile record, beside their declaration, in
  the summary and from the public record read. **Built.**

The inputs it keeps are the follow-edge index, the block index and the
monitor's interest policy below. None of them is served raw. Declaration
snapshots and DID documents belong to the key monitor
([serving them to devices](key-transparency.md#serving-held-snapshots-and-documents-to-devices)).

## What is built, and what is not

| element | status |
|---|---|
| The monitor's **interest policy**: an allow list of DIDs it keeps records for, `registered` (the default: registered users and, once follow edges are written, the DIDs they follow) or `everyone` (every declaration holder), set by `INTEREST_POLICY` | **built** — `registered` needs a `pmrDirectory` binding, and only `everyone` runs the relay backfill and takes in declaration commits for DIDs it does not already follow. DIDs join and leave the list with an epoch check, so nothing is stored for a DID that left while a fetch was in flight; under `registered` the declaration socket ignores commits outside it |
| The monitor's **profile snapshot**: the records named in `MONITOR_COLLECTIONS` (for example `app.bsky.actor.profile/self`; none when unset), verified and kept quietly beside the declaration for every DID in the allow list | **built** — no digest-window entry and no push. A holder's profile is head-checked hourly with its declaration; a DID that holds no declaration (a followee) is checked every 24 hours (`REFRESH_NONHOLDER_STALE_AFTER_MS`), with live profile events from the follow/profile stream keeping it current in between |
| The monitor's **follow-edge index**: who each graph owner follows, in D1, with the follower counts the interest policy needs | **built** — an owner is a registered user under `registered`, a declaration holder under `everyone`. Live follow events keep it current; an owner listing (one verified `getRepo`, or `listRecords` pages for a repo past the walk's caps) writes it in full. A graph is served only after its owner listing completes; until then the [summary](wire-api.md#summary) answers "not served yet". The graph is read only by the relay, over the ingest binding, to choose a summary's contacts: no route, KV key or job publishes it. Each summary poll costs two RPCs to the ingest object (the graph and the owner's blocks), each one D1 batch |
| The monitor's **block index**: `app.bsky.graph.block` records, in D1, not projected or served publicly | **built** — every block of a served graph's owner, and a non-owner in interest's blocks of registered DIDs. Live block events ride the follow socket; listings read blocks with the follows, from the same verified `getRepo` (each collection under its own cap) or by `listRecords` pages. A DID's block rows are pruned with its follows when it leaves interest or its graph stops being served. Block lists have no public projection and no public route, since no device reads another DID's and serving them would cost: an owner reads only their own, through the authenticated [summary](wire-api.md#summary), which the relay fills from the monitor over its ingest binding; other DIDs' blocks only answer whether one DID blocks another |
| **Mutual hints**: for each non-owner in interest, its follows of registered users, from `listRecords` | **built** — under `registered`, a followee's follows of a registered user are the hint that the followee follows them back |
| **Mixed provenance** of edges | **built** — rows from a verified `getRepo` listing are proven under the owner's signing key; paged-owner, mutual-hint and live rows are not. Every edge is a hint, not proof |
| The owner's summary: their own blocks, and each contact's declaration and profile | **built** — owner-authenticated ([wire API](wire-api.md#device-reads--records-and-summary)); routes are mounted by the deploying Worker |
| The public "can A message B" verdict, and per-contact verdicts in the summary | **not yet built** |

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
