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
| `POST` | `/registration` | anchor realm | register, or rebind the push subscription |
| `DELETE` | `/registration` | anchor realm | deregister |
| `GET` | `/digest?cursor=` | none | Bloom filter of changed DIDs, by window |
| `GET` | `/records/{did}` | none | the community view: one record, as CAR |

Singular throughout, including `POST` — a deliberate divergence from the
PMR, whose create is plural (`POST /pmr/v1/registrations`) while its
read/mutate/delete are singular (`wire-api.md`'s convention: an owner's own
single resource is singular, with no identifier in the path, since the
authenticated identity names it). The PMR needs the split because create
and mutate are different operations (`PATCH` covers the mutable fields).
Here `POST` **is** both create and rebind — there is no separate `PATCH` —
so one singular path names the one resource for every verb that touches it.

### Registration and the own-DID push

A registration binds a DID to a push destination; the monitor pushes when
that DID's own record changes — a rev advancing or regressing, a key
rotation observed via an identity event even when `rev` did not move, and
a **repo-level** terminal state confirmed at the source (the repo gone,
taken down, suspended, or deactivated — never inferred from a bare
unreachability). This is deliberately narrower than "the record deleted":
per `com.atproto.sync.getRecord`'s own lexicon, deleting a single record
still answers with an inclusion-exclusion proof over the *repo*, which
flows through the ordinary rev-advance path above, not this one — a
repo-level state is what has no such proof to serve instead. Not every
one of these is permanent, either: a takedown or suspension may lift, and
the monitor keeps that DID open to the next identity/account event
noticing a reversal rather than treating it as settled forever. Even so,
this is not a lesser case: it is arguably the single most alarming kind
of change this component could observe, one step further than a rev
regression or a key rotation. On a confirmed repo-level state the monitor
also stops serving the stale record — continuing to answer
`GET /records/{did}` with proof of a record whose repo no longer serves
it would misrepresent the community view, not merely leave it stale.
This is the security primitive of the component: the device holds ground
truth for its own key, so a single honest monitor detects a malicious
publication of it — or its disappearance.

**Registration authenticates to the declared anchor key** (the same
`anchor` realm a relay registration uses), not to any atproto-side
credential. The reason is that atproto account authentication is mediated
by the party this component exists to check. Binding the push channel to
the device-held key means a PDS cannot rebind or deregister the
notification before swapping keys: the swap notifies the push destination
bound to the old key. Registration is publish-then-register — a record must
exist to authenticate against.

**This property only holds if a mutation of an EXISTING registration is
verified against the key stored at create time, never the currently-declared
one.** `POST` with no existing registration verifies against the DID's
current declaration (there is nothing else to check against). `POST` with
an existing registration, and `DELETE`, both verify against the *stored*
key, unconditionally — and the stored key is never rewritten by a `POST`,
only the subscription fields are. A legitimate key rotation is therefore
**`DELETE`, signed with the old stored key, followed by re-`POST`**, which
verifies against the now-current declaration — never an in-place rebind of
the key itself. A device that loses its old key before completing this
(e.g. a reinstall) cannot rebind or deregister; that is bounded and
self-healing, since the stranded subscription eventually answers 404/410 at
the push service and the registration is dropped, ready for the device to
re-register fresh under its current key.

Body (provisional CBOR, single-letter keys — the same vocabulary the PMR's
owner endpoints use): `{ pse: string, psk: bstr(32), psi: uint(0..255) }` —
the subscription endpoint, its 32-byte content key, and the device-assigned
`keyId`. Required, unlike the PMR's own registration: a monitor registration
with no destination has no meaning. A monitor registration's subscription
is its own, never shared with a co-located relay's — `keyId` is
device-global across every deliverer a device holds.

Push delivery is [Web Push](wire-api.md#push-delivery--web-push-optional),
with both custody properties intact: the monitor holds a subscription,
never a push token, and the payload is sealed under a device-provisioned
symmetric content key the push service cannot read. A **browser** client
can register with a monitor using the literal Push API — its subscription
comes from its browser's own push service, with no additional
infrastructure anywhere in the path. **The push is content-free** — exactly
`{t:"d"}`, per [the sealed payload](wire-api.md#the-sealed-payload), never
the changed DID or the observed `rev`: bundling "here's what changed" would
let a compromised deliverer assert a declaration directly to the device,
bypassing the fetch-and-compare-across-monitors step this system exists to
force. There is only one DID a registration's push could mean, so the
device already knows which record to re-fetch and verify; it must never
trust the push content itself.

Deregistration revokes the delegation and forgets the subscription. Nothing
a monitor holds is issued to third parties, so dropping one leaves no peer
holding anything that stops working.

### The change digest

`GET /digest?cursor=…` — unauthenticated, **identical bytes for every
caller** at the same cursor, and cacheable. This surface serves the
population the other two cannot serve without cost: DIDs the device cares
about that carry no public signal. The monitor publishes what changed and
learns nothing about who cares; the device tests its private set locally
and fetches only the hits.

The digest is a **change notice over a baseline the client already holds**,
not a source of truth, so there is no genesis to sync. A new client's
baseline is the records it verifies directly at first contact; it starts
its cursor at the current window and looks only forward.

#### Windows

A monitor divides time into **fixed windows** and publishes, for each, a
filter over the DIDs whose records changed in it — every change in its
coverage, not only those of registered DIDs. Restricting the population to
known-interesting DIDs would make the filter a function of who registered,
and would miss the private contacts this surface exists for.

**A window is identified by its start instant**, in epoch milliseconds,
which MUST be a multiple of the width. Not an index: `floor(t / width)` is
ambiguous the moment a monitor retunes its width — index `5` covers
minutes 50–60 at a ten-minute width and 25–30 at a five-minute one — so
every identifier would name two different intervals. A client computes the
window it wants from a timestamp and reads the width from any window it
already holds.

**Membership is by observation time**: a DID appears in the window in which
*this monitor confirmed* the change, not the window in which the change was
published. A monitor's authoritative fetch may lag arbitrarily — a
counterpart's PDS may be unreachable for hours — and a sealed filter cannot
be amended, so indexing by publication time would drop a change into a
window already served and make it permanently invisible. Two consequences a
client MUST respect:

- **Window numbers are monitor-local.** Two honest monitors that confirmed
  the same change at different moments place it in different windows.
  Digest windows MUST NOT be compared across monitors; the `rev`
  comparison is the only cross-monitor test
  ([`trust-model.md`](trust-model.md#why-more-than-one-monitor-is-load-bearing)).
- **A monitor's downtime is indistinguishable from quiet**, and correctly
  so: nothing was observed, so nothing is reported, and the backlog appears
  in whichever window finally confirms it.

**Only closed windows are published.** The current window is still
accumulating; serving it would return different bytes to two callers a
second apart, forfeiting both cacheability and the identical-bytes property
this surface's privacy rests on. The cost is a latency floor: a change is
invisible to the digest for up to one window width. A client that needs
tighter latency uses the own-DID push, which has none.

#### The filter

The filter is a **Bloom filter**, and its guarantee is one-sided in the
direction that matters: a DID that changed MUST NEVER test negative. A
false negative is a key change the device never learns about — precisely
the withholding this component exists to detect. A false positive costs one
fetch of a record that turns out unchanged.

**A window MUST carry the parameters it was sealed under** — the filter
length in bits, the hash count, and the window width. This is the load-
bearing interoperability requirement, and it is what makes everything else
about the filter an operator's choice rather than a specification's: a
monitor may retune its sizing or its target false-positive rate at any
time, and windows sealed under earlier values stay readable. **This
specification therefore fixes no false-positive rate and no filter size.**
Length in bits is carried explicitly because it is not recoverable from the
byte length: a filter is padded to a byte boundary, and reading the padding
as filter bits answers negative for DIDs that are present.

A monitor SHOULD floor the filter size well above what the textbook sizing
gives for very small populations. The asymptotic formula is a poor guide
where windows hold a handful of members, which is the common case for a
single collection: at one member it yields ten bits and seven hashes,
saturating the filter and pushing the error rate roughly eightfold above
its target, where a 64-bit floor costs eight bytes and removes the problem.

Implementations MUST agree exactly on bit indexing — the hash input
encoding, the derivation of positions from it, and the bit order within
the filter — because a client that indexes differently reads a different
filter and silently misses changes. That failure is invisible from both
sides. The reference implementation's derivation and its test vectors are
in `packages/monitor`; a second implementation MUST reproduce those
vectors.

#### The response

A page, not a bare list of windows, because three facts have to travel with
them and none is derivable from the windows alone:

| field | meaning |
|---|---|
| `windows` | the sealed windows in `[cursor, sealedThrough]`, oldest first |
| `oldest` | the earliest window still retained |
| `sealedThrough` | the newest published window |
| `nextCursor` | where to resume |

**A client whose cursor precedes `oldest` has lost coverage** and MUST fall
back to re-verifying its interest set directly — the cost it would pay with
no digest at all. This is why the floor is published rather than implied:
without it, "past retention" and "nothing changed in any window" are the
same empty answer, and the failure is silent in exactly the case where
coverage was lost. A monitor MUST NOT serve windows below `oldest`, since
doing so would present a partial view as a complete one.

**A monitor MAY return fewer windows than the range holds**, and a client
knows it is caught up when `nextCursor` exceeds `sealedThrough` — not from
a separate truncation flag, which would be a second source of the same
truth and free to disagree with the first. A monitor SHOULD bound a page by
the **size of the filters it carries** rather than by a window count: a
count is fixed against a change rate that is not, so it goes stale as a
population grows, where a byte budget self-adjusts.

A window with no changes is a real answer and MUST be served as an empty
filter rather than omitted, so that "nothing changed here" and "not
published yet" stay distinguishable. A monitor need not store such windows;
`sealedThrough` is what licenses synthesising them on read, since it
asserts that everything at or below it has been sealed.

**A request carrying no cursor is a bootstrap, not an error.** A client
with no baseline has nothing to diff — it verifies records directly at
first contact — so a monitor SHOULD answer with an empty page whose
`nextCursor` names the current window, telling the client where to begin.

#### Caching

Cacheability is a correctness property here, not only an efficiency one: a
page held past its validity reports coverage the monitor never gave, and on
this surface stale coverage reads as "nothing changed".

The distinction is whether a page reaches the tip:

- A page whose `nextCursor` is **at or below `sealedThrough`** is fully
  determined — every window in it is sealed and the range cannot grow — and
  MAY be cached indefinitely.
- A page that runs to the tip **gains windows as they seal**, and MUST NOT
  be cached beyond one window width.

This is also why the truncation signal is `nextCursor` against
`sealedThrough` rather than a flag: the same comparison that tells a client
whether to keep paging tells a cache whether the answer can be kept.

### The record fetch

`GET /records/{did}` — unauthenticated. Returns the monitor's held record
for the DID **as CAR**, with the `rev`, `observedAt`, `source`, and
`signingKey` it holds. Never JSON: the response must be verifiable, because
a monitor is as untrusted as any relay
([trust-model §P2](trust-model.md#p2--relayed-repo-records-are-car)).

`source` (the PDS the record was fetched from) and `signingKey` (the
atproto verification method the DID document carried at fetch time, absent
if the document carried none) are **provenance, not a check this monitor
performed** — a monitor is a pass-through (Q-PMR-24) and does not verify.
They are what makes the comparison below meaningful: a monitor's own
fetch already discards nothing here, so a client comparing two monitors'
records can tell a legitimate key rotation apart from a stale or dishonest
observation, which `rev` and content alone cannot do.

This is the community view: what this monitor holds as the current record
for that DID. A client uses it to cross-check against its own fetch,
against other monitors, and against what its relay resolved, applying the
comparison rules in
[`trust-model.md`](trust-model.md#why-more-than-one-monitor-is-load-bearing):
**compare under a common authority, or not at all** — check `signingKey`
first, and only once it agrees does a `rev`/content comparison mean what
it looks like it means. Differing `rev` under a shared authority is skew;
a `rev` that moved backwards is the alarm; same `rev` with different
content is the strongest signal available from these two fields alone,
but escalates to a client's own decode-and-verify rather than standing as
proof on its own — a CAR's block ordering is not guaranteed deterministic,
so two honest fetches can differ byte-for-byte. A differing `signingKey`
is neither skew nor an alarm — it means the DID document moved between the
two observations, which the PLC log settles, not these two records
(and which nothing settles at all for `did:web`).

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
- **Prefix-sharded digests** — fetching only the shards matching your
  DIDs' hash prefixes — as an alternative to whole-population filters at
  scale. It trades a bounded, k-anonymous disclosure for a digest that
  scales with the client's interest set rather than the monitor's
  coverage. Not needed at the sizes a single collection produces.
- **What the client does on detection** — alarm, refuse the record, both;
  refusal on a false positive is a self-inflicted outage, and skew makes
  false positives real.
- **Registration expiry.** The rebind flow after a legitimate key rotation
  is now specified above (delete under the old key, re-register under the
  new); what is still open is whether a registration should lapse on its
  own after long inactivity. A registration stranded by a device that lost
  its key is reclaimed by the push service's 404/410 discard, not by
  expiry, so this is a cost/hygiene question rather than a correctness gap.
- **Concrete body schema for the delta response** — the digest's own
  serialization is settled above; registration's body is now specified
  above too.
- **Domain deltas** — a `GET /changes?domain=&cursor=` surface for a
  public-interest domain of DIDs (e.g. the caller's follow graph), as a
  cheaper alternative to the whole-population digest for a caller with a
  large, publicly-derivable interest set. Superseded for now by the
  change digest, which covers the same need without a second mechanism;
  the `changedSince` seam it would have used was removed with the
  DO-read-offload refactor since it had no production caller.
- **A stronger rotation anchor.** `signingKey` alone says *that* the
  authority differs, not *when* it changed relative to either observation.
  For `did:plc`, the PLC log's operation CID would place a rotation in
  time rather than merely flag it — an extra fetch against the log, worth
  adding alongside the client-side verifier. `did:web` has no equivalent;
  a document digest is the best available there.
