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
monitor's interest policy, which limits both to the host's users and the DIDs
they follow. None of them is served raw. Declaration
snapshots and DID documents belong to the key monitor
([serving them to devices](key-transparency.md#serving-held-snapshots-and-documents-to-devices)).

## Keeping the indexes current

The follow and block indexes are sized for every holder, like the key monitor,
so they follow the same rule
([freshness from coverage](key-transparency.md#freshness-comes-from-coverage-not-polling)):
they MUST NOT be kept current by re-listing repos on a schedule.

- **The live stream is the source.** Follow and block commits arrive on the
  firehose and are applied as they come, so cost grows with the number of
  changes.
- **A listing** (a verified `getRepo`, or `listRecords` pages) runs when a DID
  enters interest or registers, and after a stream gap the stream cannot
  replay. Never on a timer.
- **Edges and blocks are hints, not proof**, whichever path wrote them. A
  verdict built on them is a hint the device can check against the signed
  records.

## Inbound blocks at registration

The block index keeps a non-owner's blocks of registered DIDs only, and nothing
re-lists on a timer. So when a user registers, the blocks of them made earlier
by DIDs the index already lists would never arrive. The user's followees are
covered, because registration queues their listings. Everyone else is covered
by a **backlink lookup**:

- At registration the appview asks a backlink index for the
  `app.bsky.graph.block` records whose `subject` is the user. That index is
  any service that indexes atproto records by the DIDs they reference.
- For each blocker in interest, the appview reads that block record from the
  blocker's repo and verifies it before keeping it. The backlink index is
  untrusted: it can only point at a record. A record it fails to return is
  missed until the blocker's next block event or listing.
- Blockers outside interest are not kept, because no verdict the appview
  serves depends on them.
- The lookup tells the backlink index that someone is interested in the user's
  blockers when they register, but not who.

**Not yet built.** Until then, a block made before registration by an
in-interest DID that is not one of the user's followees is not caught.
