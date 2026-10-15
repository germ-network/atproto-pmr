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
  blocks. It is public, for a recipient whose declaration the PMR holds
  ([wire API](wire-api.md#can-message-verdict)), and reports a fact it cannot
  establish as unknown rather than guessing. **Built.** In the owner's summary,
  for each of the owner's contacts, as the owner messaging that contact
  (changed verdicts only, with the contacts that lost one). **Built.**
- **The user's own blocks.** The owner's block list, in the owner's
  authenticated summary, sent whole when it changes. **Built.**
- **Profiles.** Each contact's profile record, beside their declaration, in
  the summary and from the public record read. **Built.**

The inputs it keeps are the follow-edge index, the block index and the
monitor's interest policy. Under the default policy that is the host's users
and the DIDs they follow; a deployment that serves everyone keeps every
declaration holder. None of them is served raw. Declaration
snapshots and DID documents belong to the key monitor
([serving them to devices](key-transparency.md#serving-held-snapshots-and-documents-to-devices)).

## Keeping the indexes current

The follow and block indexes must scale to a deployment that serves every
holder, like the key monitor, so they follow the same rule
([freshness from coverage](key-transparency.md#freshness-comes-from-coverage-not-polling)):
they MUST NOT be kept current by re-listing repos on a schedule.

- **The live stream is the source.** Follow and block commits arrive on the
  firehose and are applied as they come, so cost grows with the number of
  changes.
- **What the index keeps.** Every follow and block of an owner (a user whose
  graph the host serves), and a non-owner's follows and blocks of registered
  users only. The rules below apply to records the index keeps.
- **A listing** (a verified `getRepo`, or `listRecords` pages) runs when a DID
  enters interest, registers, or is followed by a registering user, and after a
  stream gap the stream cannot replay. Never on a fixed timer.
- **Repair on anomalies.** For an owner, an event the index cannot apply
  cleanly, such as a delete of an rkey it does not hold or a create that
  re-points a held rkey, marks the owner for a listing at once. For a
  non-owner, a delete of an unheld rkey is ordinary (the index never kept that
  record) and is not an anomaly.
- **A cheap probe, a continuity backup.** Per indexed DID, the appview asks
  for the newest follow record and the newest block record (one record each).
  Record keys are time-ordered, so a newest record the index would keep but
  does not hold means it missed a create, and that collection is re-listed. For
  a non-owner, a newest record whose subject is not registered tells it
  nothing, and the probe passes. The probe runs on an
  exponential backoff: the first interval is **one week**, it doubles after
  each probe that finds nothing missed, and it is capped at **30 days**. It is
  jittered, and a follow or block event for the DID resets it.
- **Missed deletes.** The probe cannot see a missed delete, such as an unblock.
  For an **owner**, whose own blocks a PMR enforces, the probe reaching its
  30-day cap also runs a **full listing** of both collections, so a missed
  delete in an owner's lists lasts at most about 30 days. For a non-owner it is
  repaired by a gap's listing or the DID's next listing; until then it skews
  only a prediction.
- **Edges and blocks are hints, not proof**, whichever path wrote them. A
  verdict built on them is a hint the device can check against the signed
  records.

## Inbound blocks at registration

The block index keeps a non-owner's blocks of registered users only. So when a
user registers, blocks of them that a non-owner made earlier are missing,
unless the user follows that DID (registration lists the user's followees).

This affects no verdict today: a verdict reports a non-owner recipient's blocks
as unknown ([wire API](wire-api.md#can-message-verdict)). It would matter if
verdicts used non-owner rows to answer no. An owner's blocks are all kept, so
an owner's block of the new user is never missing.

**Optional: a backlink lookup.** A deployment MAY add the blocks a backlink
index points at, at registration:

- Ask a backlink index (any service that indexes atproto records by the DIDs
  they reference) for the `app.bsky.graph.block` records whose `subject` is
  the user.
- For each blocker in interest, read that block record from the blocker's repo
  and verify it before keeping it. The index is untrusted: it can only point at
  a record, and a record it does not return proves nothing.
- Keep no blockers outside interest, because no verdict the appview serves
  depends on them.

The lookup tells the backlink index that someone is interested in the user's
blockers when they register, but not who. **Not yet built.**

A block is enforced by the recipient's own PMR, which keeps all of its users'
blocks and treats a blocked sender as
[§Blocked senders](wire-api.md#blocked-senders) requires: the sender cannot
tell. Receive-time enforcement is **built**, where the relay is wired to the monitor's graph: the PMR mirrors the recipient's
Bsky blocks into the relay block at accept and at each catch-up, and judges
each pair put against the recipient's policy
([wire API](wire-api.md#receive-time-admission)).
