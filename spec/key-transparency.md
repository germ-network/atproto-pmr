# Distributed Key transparency for atproto messaging — the key monitor

**First public draft.**

_A **key monitor** assembles a key directory out of self-published keys on the atmosphere,
giving atproto what Certificate Transparency gives web PKI: the assurance that the keys
everyone is being shown are the **same** keys. It consumes the firehose,
holds a snapshot of every messaging key declaration in its coverage, and
serves that snapshot as a community view — so a publisher that shows
different keys to different audiences cannot do it quietly._

This document specifies the key monitor: a component
[separate](wire-api.md#monitoring--a-separate-component-not-a-relay-surface)
from a [Personal Messaging Relay](README.md#what-an-atproto-pmr-is), which
a relay operator is encouraged but not required to run alongside one.

## The goal

Atproto users can reliably publish user-controlled keys via the atmosphere. For E2EE messaging, this assures that people are messaging
to keys honestly issued by the intended remote party.

The mechanism is a consistent, observed view of **the repo record in which
a DID publishes a messaging key**.

In this deployment that record is the Germ declaration and the key is the
**anchor key** ([README §Dependencies](README.md#dependencies-on-a-non-atproto-record-format)),
and the rest of this document names them concretely. Nothing in the
mechanism depends on that choice: it applies to any key a DID publishes in
a repo record.

## The trust structure, mapped to Certificate Transparency

This is structurally CT, not a centralized key-transparency directory.
There is no single issuer to hold accountable: each user's PDS issues on
that user's behalf, because it holds the repo signing key. The threat is
the PDS misusing that signing capability, and the defense, as in CT, is
third parties recording what they observe.

| CT | here |
|---|---|
| certificate | the published record — a key binding signed under the DID's repo signing key (here, the declaration) |
| certificate authority | the PDS, holding the repo signing key as the DID's delegate |
| monitor | the **key monitor** — observes all issuance in its coverage via the firehose |
| relying party | a messaging peer, verifying the record's CAR proof |
| auditor | the client, cross-checking its monitors against each other |
| the append-only log | a later enhancement — see [the appendix](#appendix-the-append-only-ledger-non-normative) |

Two honest differences from CT:

- **Freshness is stronger than CT's.** CT has no freshness story at all.
  A monitor is on the firehose, so its view is near-real-time, and its
  `rev` tracking is what turns replay of a stale-but-genuine record
  into a detectable event.
- **There is no inclusion gate.** CT relying parties can require an SCT —
  proof a certificate was logged — before trusting it. Here, because of freshness and self-certifying data, clients can directly consult key monitors.

## What authenticated transfer gives, and what the monitor adds

Authenticated transfer separates the capability of issuing keys from the
assurance of freshness and consistency. Issuance requires the DID's repo
signing key, because a published key is a signed repo record. Third parties
— any relay, any monitor, any peer — cannot issue; their forgeries do not
verify.

That leaves the party that holds the key. A malicious PDS signs a genuine
commit binding an attacker's key to a DID, and every check passes: the repo
says it, and the repo is what the PDS is authoritative for. Self-fetch does
not close this, because a PDS can **equivocate by audience** — an honest
record to the owner, a malicious one to peers. What detects this is not a
second look but a look from where the peers stand: an observer independent
of the publisher, fetching as an ordinary peer does. One observer detects
uniform malice; disagreement between observers detects audience-targeted
equivocation, which no single observer can see. The argument, the `rev`
comparison table, and the client-side rules are in
[`trust-model.md` §Why more than one monitor is load-bearing](trust-model.md#why-more-than-one-monitor-is-load-bearing);
this document implements them rather than restating them.

A monitor is therefore never a primary authority of keys. A client takes keys
from records it verifies itself, and uses monitors for what verification
alone cannot give: consistency across audiences, and freshness. A monitor's
output is CAR in every case
([trust-model §P2](trust-model.md#p2--relayed-repo-records-are-car)): it is
as untrusted as any relay, cannot forge, and neither can a set of them.

## The key monitor

A key monitor:

- **consumes the firehose**, filtered to the collection that carries the
  key — the declaration collection in this deployment. The consumer is a
  standing subscription, not a request handler — though where the stream
  is cursor-resumable and server-filtered, it need not be literally
  always-on: a periodically woken consumer achieves the same coverage,
  and always-on becomes a latency choice. Coverage MUST NOT depend on an
  uninterrupted connection — a monitor MUST resume from its cursor (or
  replay) across any gap. This workload difference is why the monitor
  and a relay separate cleanly even when one operator runs both.
- holds a **stateful snapshot** of its coverage:
  `did → (rev, record CAR, observedAt)`.
- declares its **coverage**: the population of records it observes,
  typically everything visible on the firehose it consumes. Coverage is a
  published fact about the monitor, not a per-client setting.
- **serves one record type and nothing else.** The redundancy model
  depends on monitors being cheap enough to run several and simple enough
  for independent parties to operate; a general record-fetch interface
  erodes that. A conforming monitor MUST NOT require any capability beyond
  this document.

A host advertises a monitor through its
[enabler document](wire-api.md#the-enabler-document): a `monitor`
capability entry whose `pathPrefix` names where these surfaces live,
possibly on a different host from any mailbox surface. The paths below are
relative to that prefix. Request authentication reuses the
[wire API's conventions](wire-api.md#request-authentication) — RFC 9421
signatures over server-issued challenges — from the host's `core`
capability.

## Surfaces

| method | path | auth | purpose |
|---|---|---|---|
| `POST` | `/registrations` | anchor realm | register: own-DID push on any change |
| `DELETE` | `/registrations` | anchor realm | deregister |
| `GET` | `/changes?domain=&cursor=` | anchor realm | deltas for a public-interest domain |
| `GET` | `/digest?cursor=` | none | Bloom filter of changed DIDs, by window |
| `GET` | `/records/{did}` | none | the community view: one record, as CAR |

### Registration and the own-DID push

A registration binds a DID to a push destination; the monitor pushes when
that DID's own record changes. This is the security primitive of the
component: the device holds ground truth for its own key, so a single
honest monitor detects a malicious publication of it.

**Registration authenticates to the declared anchor key** (the same
`anchor` realm a relay registration uses), not to any atproto-side
credential. The reason is that atproto account authentication is mediated
by the party this component exists to check. Binding the push channel to
the device-held key means a PDS cannot rebind or deregister the
notification before swapping keys: the swap notifies the push destination
bound to the old key. Registration is publish-then-register — a record must
exist to authenticate against.

Push delivery reuses the
[push delegation shape](wire-api.md#push-delegation-optional) unchanged,
including both custody rules: the monitor holds a push grant, never a push
token, and the payload is sealed under a device-shared content key. The
push carries the changed DID and the monitor's observed `rev`; the device
responds by fetching and verifying, not by trusting the push content.

Deregistration revokes the delegation and forgets the subscription. Nothing
a monitor holds is issued to third parties, so dropping one leaves no peer
holding anything that stops working.

### Domain deltas

`GET /changes?domain=follows&cursor=…` returns the records that changed,
since the cursor, among a domain of DIDs derived from the caller's public
records — for example the caller's follow graph. Naming this set to a
monitor discloses nothing new: it is already a public record in the
caller's own repo.

The response is a page of `(did, rev, record CAR)` plus a `nextCursor`,
following the [cursor convention](wire-api.md#not-yet-specified). The client
verifies every returned record; the monitor's word is never the key.

Authentication is the anchor realm: the request names a DID regardless, so
authenticating costs no disclosure and gives the monitor a principal to
rate-limit.

### The change digest

`GET /digest?cursor=…` — unauthenticated, identical bytes for every caller
at the same cursor, and cacheable. This surface serves the population the
other two cannot serve without cost: DIDs the device cares about that carry
no public signal. The monitor publishes what changed and learns nothing
about who cares; the device tests its private set locally and fetches the
hits.

- The monitor maintains **fixed windows** (width implementation-defined and
  published). For each window it publishes a **Bloom filter over the DIDs
  whose records changed in that window** — every change in its coverage,
  not only registered DIDs'. Restricting the population to known-interesting
  DIDs would make the filter a function of who registered, and would miss
  the private contacts this surface exists for.
- **The digest is a change notice over a baseline the client already holds,
  not a source of truth**, so there is no genesis to sync. The cursor is an
  opaque window identifier, held client-side; the monitor keeps no
  per-client digest state. A new client's baseline is the records it
  verifies directly at first contact, so it starts its cursor at the
  current window and looks only forward.
- Catch-up spans `[cursor, now]`, as a sequence of per-window filters or
  their union at the monitor's option (a union's false-positive rate
  degrades as windows merge; the response says which it is). Filter
  parameters — size, hash count, window covered — ride with the response,
  so the filter is self-describing.
- **Past the published retention the answer is a defined "too old", and the
  client falls back to direct re-verification** of its interest set — the
  polling it would do without a digest. This is a return to the pre-digest
  cost, not an error and not a gap in coverage.

False positives are a size/rate tradeoff, not a privacy or correctness
cost: a false positive triggers one verified fetch that finds nothing new,
indistinguishable from routine polling. False negatives cannot occur within
a covered window, since a Bloom filter has none. The miss that matters is a
monitor withholding a change from the digest, which is caught where all
monitor dishonesty is caught: cross-monitor comparison, and the own-DID
push for one's own key.

### The record fetch

`GET /records/{did}` — unauthenticated. Returns the monitor's held record
for the DID **as CAR**, with the `rev` and `observedAt` it holds. Never
JSON: the response must be verifiable, because a monitor is as untrusted as
any relay ([trust-model §P2](trust-model.md#p2--relayed-repo-records-are-car)).

This is the community view: what this monitor holds as the current record
for that DID. A client uses it to cross-check against its own fetch,
against other monitors, and against what its relay resolved, applying the
`rev` rules in
[`trust-model.md`](trust-model.md#why-more-than-one-monitor-is-load-bearing):
differing `rev` is skew; same `rev` with different content, or a `rev` that
moved backwards, is the alarm.

## The two comparisons, and their different weights

- **Own-DID**: the device knows its own key, so it holds ground truth. One
  honest monitor detects a malicious publication; disagreement among
  monitors detects audience-targeted equivocation. This is why registration
  and push exist.
- **Counterpart-DID**: no ground truth, so the test is agreement — monitors
  with each other and with the relay's resolved view. Disagreement is not
  proof of malice, since skew is real; it promotes a direct verified fetch
  from routine to warranted. CAR covers a counterpart's record against
  forgery by any relay or monitor, so the counterpart residue is
  withholding and staleness — a freshness problem, not an impersonation one.

## Independence and plurality are the client's job

Restating the [trust-model rules](trust-model.md#choosing-monitors-is-the-clients-job)
to anchor them here: a client MUST NOT rely, for the own-DID surface, on a
monitor hosted by the party that hosts its repo; MUST NOT accept a
deployment's self-claim of independence; and SHOULD register with more than
one monitor. Host comparison rules out the accidental case, not the
adversarial one, so plurality is the actual defense. A client whose entire
monitor set fails the independence test has no independent view, a state
worth surfacing rather than silently accepting.

The monitor set is chosen — configured or defaulted by the client — never
resolved from the DID, because a resolved monitor inherits the resolution
chain's trust and the chain runs through the publisher.

## Appendix: the append-only ledger (non-normative)

A later enhancement makes a monitor's history auditable rather than only
its present state observable: the monitor commits its observation stream to
an append-only Merkle log, publishes signed tree heads, and serves
inclusion and consistency proofs (RFC 9162's mechanics, applied to record
observations). That upgrades "this monitor's snapshot says X" to "this
monitor is bound to a history that says X, and cannot rewrite it without
producing two irreconcilable tree heads", letting monitors audit each other
and clients audit monitors over time. Out of scope for v1; the surfaces
above are designed to admit it without change.

## Not yet specified

- **How a client learns its monitor set** — configured, defaulted, or
  discovered — and a sensible default.
- **How many monitors make the redundancy real**, and the shape of the
  no-independent-view warning.
- **Offline catch-up across many windows** — union-degradation limits, and
  whether prefix-sharded digests (fetch only the shards matching your DIDs'
  hash prefixes) replace whole-population filters at scale.
- **What the client does on detection** — alarm, refuse the record, both;
  refusal on a false positive is a self-inflicted outage, and skew makes
  false positives real.
- **Registration lifecycle** — expiry, and the rebind flow after a
  legitimate key rotation (the old key's push destination fires on the
  rotation; how the new key re-registers without that being mistaken for an
  attack).
- **Concrete body schemas** — field-level CBOR for registration and the
  delta response, and the digest's serialization, under the wire API's
  [encoding rules](wire-api.md#deterministic-cbor).
