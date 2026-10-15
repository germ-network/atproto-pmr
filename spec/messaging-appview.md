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

## Known gap

A newly registered user's existing inbound blocks from in-interest DIDs that are not their followees reach the index only at each blocker's next stale re-list (`FOLLOW_RELIST_AFTER_MS`); their followees' blocks are caught by the followee listings registration already queues.
