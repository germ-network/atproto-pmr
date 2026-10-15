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

## Known gap

A newly registered user's existing inbound blocks from in-interest DIDs that are not their followees reach the index only at each blocker's next stale re-list (`FOLLOW_RELIST_AFTER_MS`); their followees' blocks are caught by the followee listings registration already queues.
