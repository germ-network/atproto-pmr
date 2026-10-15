# atproto Personal Messaging Relay — specification

**First public draft.**

_The wire surface, the storage consistency contract, and the security
properties of an **Atproto Personal Messaging Relay** (Atproto PMR): a
persistently online, weakly trusted delegate of an
[atproto](https://atproto.com/) DID that operates end-to-end encrypted
mailboxes and observes atproto state on that DID's behalf._

## What is an Atproto PMR

A **Personal Messaging Relay** is a weakly trusted, persistently online
delegate of a user's device set, facilitating the sending and receiving of
end-to-end encrypted (E2EE) messages. "Weakly trusted"
[means](trust-model.md): **trusted for the availability and ordering of
opaque ciphertexts**

An **atproto PMR** is the variant bound to a public identity - an atproto DID. The delegation
is established by publishing a messaging identity key — the **anchor key**
— in a declaration record in that DID's atproto repository.

The atproto PMR can operate mailboxes for each sender/receiver pair of DID's, authenticating
the sender against the delegate anchor key.

| mailbox kind | key | how many a user may have |
|---|---|---|
| pair | the counterpart DID, verbatim | **exactly one relay, designated by the recipient** |
| grant | `grant:` + an opaque derived address | **any number, across any number of relays** |

Both arrive on one path, `POST /pmr/v1/inbox/{key}/messages`, distinguished by
the key's prefix (§[Delivery — peer-facing](wire-api.md#delivery--peer-facing)).
The cardinalities differ because the routing does:

- A **grant carries its own host**, and its address is derived under that
  host (§[Grant address and put-tag derivation](wire-api.md#grant-address-and-put-tag-derivation)),
  so a peer holding a grant needs nothing else to route to it. A user may
  hold grants from several relays at once.
- A **pair put is routed by resolving the recipient's DID**, and that
  resolution yields one relay, so there is exactly one pair mailbox per
  DID pair. Its reachability is not yet defined — see
  [the discovery hop](#not-yet-specified).

**Grant issuance is the core PMR capability** 
A relay is a grant issuer: it
vends opaque, unguessable mailbox addresses that name no sender. DID
addressing is the entry path that runs ahead of them — first contact and
re-contact arrive on the DID-addressed mailbox, the always-resolvable
layer, and conversations then move onto grant addresses for steady state.
Grants have a fixed lifetime at mint, allowing the issuing PMR to wind down
its lifecycle though migrations
(§[Retirement](wire-api.md#retirement)).

**A host says what it can do in its capabilities document**,
`GET /.well-known/private-messaging-enabler.json`
(§[The enabler document](wire-api.md#the-enabler-document)) — which
capabilities it serves, at which versions, and under which path prefix. A
client reads it before constructing any URL; the paths in this
specification are relative to the prefix declared there.

Outbound relay is not yet in scope, devices put directly to
recipients' PMR's.

### Related capabilities
A an atproto PMR operating on behalf of a an atproto DID (messaging delegate)
should operate two other related functions to support messaging:

**key monitor** — [key transparency](key-transparency.md) 
The delegate keys are published by the PDS, we guard against publisher
misbehavior by ensuring that users have a consistent view of which keys were issued.

The key monitor does so by by providing an independent cache of the implicit
key directory that is a union of the published keys across all users' PDS's.
AT Protocol allows these key records to be [self-certifying](https://atproto.com/specs/repository),
so the monitor cannot forge keys. Similarly to other key transparency schemes,
we trust keys not when we fetch them from the issuer, but when they have reached
an independent monitor. ([`trust-model.md`](trust-model.md#p2--relayed-repo-records-are-car)).

A client isn't bound to only use its own atproto PMR's monitor, it can cross-check several.

The key monitor subscribes to [Jetstream](https://atproto.com/blog/introducing-bluesky-protocol-services#jetstream-v2-network-replay)
to get real-time updates of published keys. It also subscribes to the PLC's [update stream](https://github.com/bluesky-social/atproto/discussions/4508)

**Observation** 
If the atproto pmr is already subscribing the jetstream of record updates, it's logical that it also offload caching of
public data from the client - in effect operating an appview of the data an atproto messenger needs, which so far are
profiles and social graphs.

## Where to start

- **Relay implementers** — PDS operators and self-hosters standing up a
  relay. Read [`wire-api.md`](wire-api.md) and
  [`storage-consistency.md`](storage-consistency.md) together: the first is
  the surface you expose, the second is the state behind it.
- **Client implementers** — read [`wire-api.md`](wire-api.md) and
  [`trust-model.md`](trust-model.md). The client half is not optional:
  several guarantees here exist only because the device verifies rather
  than trusts, and a client that skips that verification removes them.
- **Security reviewers and prospective adopters** — read
  [`trust-model.md`](trust-model.md) first. It states what a relay
  necessarily learns, which is the cost of running one.

## Requirements language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP 14
[[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html)]
[[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html)] when, and only
when, they appear in all capitals, as shown here.

## Normative versus implementation-defined

These documents distinguish two kinds of statement:

- **Normative** — what any implementation must do: wire formats, the
  properties peers and clients depend on, and the security properties
  (closure, blocking indistinguishability, the verification rules, the
  storage consistency contract). Stated with RFC 2119 keywords.
- **Implementation-defined** — capacities, distributions, storage layout,
  sweep cadences, retention windows, and the concrete synthetic behavior a
  blocked sender observes. The operator picks these, and this
  specification says so explicitly wherever it applies.

The distinguishing test: **does anything outside this deployment depend
on the answer?** If a peer, a client, or another relay can observe it and
would behave differently, it is normative. If it only shapes local
behavior — even security-relevant local behavior — it belongs to the
implementer.

The blocked-sender simulation is the one exception: the
requirement that the behavior be *synthetic* is normative, while its shape
is deliberately **unpublished**, because a published simulation is a
fingerprint an attacker can test a relay against. See
[`wire-api.md` §Blocked senders](wire-api.md#blocked-senders).

## The documents

| document | covers |
|---|---|
| **this one** | what an Atproto PMR is, where to start, the normative split, conformance |
| [`wire-api.md`](wire-api.md) | the **normative wire surface** — request authentication, key material, the endpoint inventory, the pair-put payload and its verification algorithm, error semantics, the closure exception |
| [`storage-consistency.md`](storage-consistency.md) | the **storage consistency contract** an implementation must satisfy, stated backend-neutrally, plus the operation inventory the relay's logic runs against |
| [`trust-model.md`](trust-model.md) | the **security properties** an implementation must preserve, what a relay necessarily learns, and what a malicious one can do |
| [`key-transparency.md`](key-transparency.md) | the **key monitor** — key transparency for atproto messaging: the CT-shaped trust structure, the monitor's surfaces (own-DID push, the change digest, the community-view fetch), freshness from firehose coverage, the stored DID document and coverage watermarks, serving held declarations to devices (the 24-hour rule), and the append-only-ledger enhancement |
| [`messaging-appview.md`](messaging-appview.md) | the PMR as a **messaging appview**: what it computes for its users (whether they can message a DID, their own blocks, contacts' profiles), the posture of its public reads, and how its follow and block indexes stay current |

## Dependencies on a non-atproto record format

Two things in this protocol are specific to the messaging system it was
built for.

**The germ declaration record.** The relay resolves a sender's DID to a
declaration record in that DID's atproto repository and reads the anchor
key out of it. Those key fields are frozen in a published record format
that predates this specification and is **not COSE**: the field is an
algorithm identifier byte followed by the raw public key bytes, with no
enclosing structure. A relay converts it to a `COSE_Key` on ingest, once,
so that nothing downstream handles two formats. That single field is an
implementer's entire exposure to the foreign format — the relay never
parses the declaration's key package, never writes a declaration, and
every other key on every other surface is COSE. See
[`wire-api.md` §Key material](wire-api.md#key-material).

**Push delegation.** Mobile push entitlements are not transferable between
operators, so a self-hosted relay on such a platform cannot talk to the
platform's push service itself. The protocol therefore admits an optional
delegation path in which the relay presents a client-minted capability to a
push service that can. In the reference deployment that service is operated
by Germ. It is a deployment-specific delivery path, not a requirement: a
self-hoster on a platform without that constraint delivers push directly
and implements none of it. See
[`wire-api.md` §Push delivery](wire-api.md#push-delivery--web-push-optional)
— which is **Web Push** (RFC 8030/8292 plus a symmetric, post-quantum
payload seal), so any deployment or push service speaks a standard
surface rather than one invented here.

## Conformance summary

An implementation conforms if it satisfies all of the following. This table
is an index, not a substitute for the sections it links.

| # | requirement | where |
|---|---|---|
| 1 | Requests are authenticated with RFC 9421 HTTP Message Signatures carrying a server-issued challenge in the `nonce` parameter; `content-digest` MUST be a covered component on any request with a body | [wire](wire-api.md#request-authentication) |
| 2 | **A put to a grant mailbox answers `202` always** — unknown, closed, live, and bad-tag addresses are identical in content *and* in time, and every address-dependent step runs after the response | [wire](wire-api.md#the-closure-exception) |
| 3 | A put to a pair mailbox answers `202`, or `429` with `Retry-After` when the sender's own reservation is full, or `400` for a malformed request decided on the request bytes alone — and **nothing recipient-dependent** | [wire](wire-api.md#delivery--peer-facing) |
| 4 | The pair-put verification algorithm runs all four steps, in order, none optional; `kid` is diagnostic and never authority | [wire](wire-api.md#the-verification-algorithm) |
| 5 | The recipient DID is inside the signature, and a verifier MUST reject a put whose signed recipient DID is not this recipient | [wire](wire-api.md#why-the-recipient-did-must-be-signed) |
| 6 | Pair puts carry an anti-replay nonce the recipient records per sender until a session supersedes it; content-addressed dedup is not a substitute | [wire](wire-api.md#anti-replay) |
| 7 | Content addressing covers the stable message identity, never the signature bytes, **and** non-canonical Ed25519 signatures are rejected — both, not either | [wire](wire-api.md#malleability) |
| 8 | Deterministic CBOR means RFC 8949 §4.2.1; non-conforming input is rejected, and an implementation emitting plain §4.2.1 MUST never be rejected for it | [wire](wire-api.md#deterministic-cbor) |
| 9 | A blocked sender's view is **synthetic**, stores no bytes, causes no delivery and no push, and matches the real path's response timing and shape | [wire](wire-api.md#blocked-senders) |
| 10 | An unprovisioned sender is accepted into the recovery pool, never refused; the pool is never pushed per arrival | [wire](wire-api.md#the-recovery-pool) |
| 11 | Relayed atproto repo records are exchanged as CAR — signed commit plus inclusion proof — never as JSON | [trust](trust-model.md#p2--relayed-repo-records-are-car) |
| 12 | The seven items of the storage consistency contract hold, whatever the backend | [storage](storage-consistency.md#the-consistency-contract) |
| 13 | The relay's verification verdict is delivered to the device as a hint and never as evidence; the device re-verifies | [trust](trust-model.md#p8--the-relays-verdict-is-a-hint) |
| 14 | Both mailbox kinds are served on one inbox path, distinguished by key prefix, with a DID carried verbatim and only a grant address prefixed | [wire](wire-api.md#delivery--peer-facing) |
| 15 | The enabler document is generated from enforced values, omits capabilities not served rather than flagging them, and its declared prefixes are where the endpoints actually answer | [wire](wire-api.md#the-enabler-document) |

Items 2 and 9 are not self-certifying. Both are timing properties, and an
implementation that satisfies them in code can lose them to an early
return, a cache, or a cheaper branch added later. Test them rather than
asserting them.

## Not yet specified

Each document carries its own "Not yet specified" section:

- [`wire-api.md`](wire-api.md#not-yet-specified) — owner-facing error
  bodies, quota disclosure headers, COSE header labels, version
  negotiation, batch shapes, nonce mechanics, custom header field naming,
  content-address algorithm identifiers, the change digest's shape, and
  concrete body schemas. Body schemas block a second implementation from
  interoperating today; the rest are edges where divergence is survivable.
- [`storage-consistency.md`](storage-consistency.md#not-yet-specified) —
  the blob interface, the observation cache's place in the interface, the
  recovery pool's cross-sender cap, stored-shape versioning.
- [`trust-model.md`](trust-model.md#not-yet-specified) — which flows get
  spot checks, `rev` staleness tolerance, quota exhaustion as a
  denial-of-service surface against the owner.
- [`key-transparency.md`](key-transparency.md#not-yet-specified) — the
  monitor-set choice and its defaults, the plurality threshold and the
  no-independent-view warning, offline digest catch-up, what a client
  does on detection, registration lifecycle, concrete body schemas.

Expect a future version to settle these. An implementation that needs one
today should treat its choice as local and be prepared to change it.

One item is deliberately not on that list. **The relay-to-relay discovery
hop** — how a sender's client learns which relay serves a given DID — is
external to this API. The canonical resolution chain is DID → DID document
→ PDS → PMR, and the last hop is not defined by this specification; nothing
in the wire surface changes when it is. The declaration record carries no
relay pointer, because that would duplicate and could diverge from what the
canonical chain already provides.
