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
- **Repair on anomalies.** An event the index cannot apply cleanly, such as a
  delete of an rkey it does not hold or a create that re-points a held rkey,
  marks the DID for a listing at once.
- **A cheap probe, a continuity backup.** Per indexed DID, the appview asks
  for the newest follow record and the newest block record (one record each).
  Record keys are time-ordered, so a newest key the index does not hold means
  it missed a create, and that collection is re-listed. The probe runs on an
  exponential backoff: the first interval is **one week**, it doubles after
  each probe that finds nothing missed, and it is capped at **30 days**. It is
  jittered, and a follow or block event for the DID resets it. The probe
  cannot see a missed delete; those are repaired by anomalies, a gap's
  listing, or the DID's next listing.
- **Edges and blocks are hints, not proof**, whichever path wrote them. A
  verdict built on them is a hint the device can check against the signed
  records.

## Inbound blocks at registration

The block index keeps a non-owner's blocks of registered DIDs only, and nothing
re-lists on a timer. So when a user registers, the blocks of them that DIDs
the index already lists made earlier do not arrive. The user's followees are
covered, because registration queues their listings. For anyone else, the
block shows up only at the blocker's next block event or listing.

A missed block only affects a prediction. The user's own summary may say they
can message someone who blocks them. The block is still enforced at the
recipient: a PMR keeps every block of its own users and adjudicates at receive
time. The send is refused there, and the prediction corrects itself.

**Optional: a backlink lookup.** A deployment MAY make the prediction complete
at registration:

- Ask a backlink index (any service that indexes atproto records by the DIDs
  they reference) for the `app.bsky.graph.block` records whose `subject` is
  the user.
- For each blocker in interest, read that block record from the blocker's repo
  and verify it before keeping it. The index is untrusted: it can only point at
  a record.
- Keep no blockers outside interest, because no verdict the appview serves
  depends on them.

The lookup tells the backlink index that someone is interested in the user's
blockers when they register, but not who. **Not yet built.**
