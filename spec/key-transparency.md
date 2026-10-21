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
from a [Personal Messaging Relay](README.md#what-is-an-atproto-pmr), which
a relay operator is encouraged but not required to run alongside one.

## The goal

Atproto users can reliably publish user-controlled keys via the atmosphere. For E2EE messaging, this assures people
that they are messaging
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
- holds a **stateful snapshot** of its coverage,
  `did → (rev, record CAR, observedAt)`, and a coverage watermark that dates
  all of it ([freshness](#freshness-comes-from-coverage-not-polling)).
- declares its **coverage**: the population of records it observes,
  typically everything visible on the firehose it consumes. Coverage is a
  published fact about the monitor, not a per-client setting.
- **serves one record type and nothing else** on its own surfaces. The redundancy model
  depends on monitors being cheap enough to run several and simple enough
  for independent parties to operate; a general record-fetch interface
  erodes that. A conforming monitor MUST NOT require any capability beyond
  this document. The relay-facing stores below (snapshots, DID documents
  and the coverage watermarks) are what a co-located relay reads; they add no
  surface.

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

A registration binds a DID to a push destination. The monitor pushes when
that DID's own record changes: a `rev` that advances or regresses, a key
rotation seen through an identity event even when `rev` did not move, or a
**repo-level** terminal state confirmed at the source (gone, taken down,
suspended or deactivated, never inferred from unreachability). On a confirmed
repo-level state the monitor stops serving the stale record. The device holds
ground truth for its own key, so a single honest monitor detects a malicious
publication of it, or its disappearance.

- **Registration authenticates to the declared anchor key** (the `anchor`
  realm), never to an atproto credential, because atproto account
  authentication is mediated by the party this component checks. It is
  publish-then-register: a record must exist to authenticate against.
- **A mutation of an existing registration MUST verify against the key stored
  at create time**, never the currently declared one. `POST` with no existing
  registration verifies against the current declaration. `POST` on an existing
  one, and `DELETE`, verify against the stored key, which a `POST` never
  rewrites. A key rotation is `DELETE` signed with the old key, then a fresh
  `POST`.
- **Body** (provisional CBOR): `{ pse: string, psk: bstr(32), psi: uint(0..255) }`,
  the subscription endpoint, its 32-byte content key and the device-assigned
  `keyId`. All are required. The subscription is the monitor's own, never
  shared with a co-located relay.
- **Delivery** is [Web Push](wire-api.md#push-delivery--web-push-optional),
  sealed under the device-provisioned content key. **The push is
  content-free**, exactly `{t:"d"}` ([the sealed payload](wire-api.md#the-sealed-payload)),
  never the changed DID or `rev`, so a compromised deliverer cannot assert a
  declaration to the device. The device re-fetches and verifies.

### The change digest

`GET /digest?cursor=…`: unauthenticated, **identical bytes for every caller**
at the same cursor, and cacheable. It serves the DIDs a device cares about
that carry no public signal: the monitor publishes what changed and learns
nothing about who cares, and the device tests its private set locally. It is
a change notice over a baseline the client already holds, with no genesis to
sync; a new client starts its cursor at the current window.

- **Windows.** Time is divided into fixed windows, each with a filter over
  every DID whose record changed in it, across the monitor's whole coverage. A
  window is identified by its **start instant** in epoch milliseconds, a
  multiple of its width, not by an index. **Membership is by observation
  time**, so window numbers are monitor-local and MUST NOT be compared across
  monitors. **Only closed windows are published.**
- **Filter.** A Bloom filter: a DID that changed MUST NEVER test negative.
  Each window MUST carry the parameters it was sealed under (length in bits,
  hash count, width), so this specification fixes no size or false-positive
  rate. Implementations MUST agree exactly on bit indexing; the reference
  derivation and its test vectors are in `packages/monitor`, and a second
  implementation MUST reproduce them.
- **Response.** A page of `windows` (sealed, in `[cursor, sealedThrough]`,
  oldest first), `oldest` (earliest retained), `sealedThrough` (newest
  published) and `nextCursor`. A client whose cursor precedes `oldest` has
  lost coverage and MUST re-verify its interest set directly; a monitor MUST
  NOT serve windows below `oldest`. A monitor MAY return fewer windows than the
  range holds, and a client is caught up when `nextCursor` exceeds
  `sealedThrough`. An empty window MUST be served as an empty filter, not
  omitted. A request with no cursor SHOULD get an empty page whose
  `nextCursor` names the current window.
- **Caching.** A page whose `nextCursor` is at or below `sealedThrough` MAY be
  cached indefinitely. One that runs to the tip MUST NOT be cached beyond one
  window width.

### The record fetch

`GET /records/{did}`, unauthenticated, returns the monitor's held record for
the DID **as CAR**, never JSON, with the `rev`, `observedAt`, `source` (the
PDS it came from) and `signingKey` (the key it verified under at ingest) it
holds. A monitor is as untrusted as any relay
([trust-model §P2](trust-model.md#p2--relayed-repo-records-are-car)), and its
check does not replace the client's. This is the community view. A
client comparing it against its own fetch, other monitors and its relay MUST
**compare under a common authority, or not at all**
([trust-model](trust-model.md#why-more-than-one-monitor-is-load-bearing)): check
`signingKey` first, then `rev` and content. Differing `rev` under a shared
authority is skew, a `rev` that moved backwards is the alarm, and a differing
`signingKey` means the DID document moved between the two observations.

## Serving held snapshots and documents to devices

A relay can answer its devices' reads of declarations and DID documents from
the monitor's stores, so the PDS and a `did:web` host do not learn which DIDs a
device looks at. That privacy is the whole of the trust: records stay CAR, a
device verifies each against the DID document itself, and it never takes the
relay's word for content or a key.

### Freshness comes from coverage, not polling

A monitor is sized for every declaration holder on the network, not for a
population small enough to poll. Its cost grows with the number of changes,
and only slowly with the number of holders: it MUST NOT re-read every holder's
PDS on a fixed schedule.

- **The coverage watermark.** A monitor keeps one instant, its watermark: every
  commit to the declaration collection, and every identity and account event,
  that the firehose sequenced before it has been applied. A held snapshot is
  current as of the watermark, not as of its own fetch. A snapshot's
  **freshness** is the later of the watermark and that DID's last direct fetch.
- **Per-DID fetches follow events.** A monitor reads a holder's PDS when an
  event names the DID, when it first learns of the DID, and during a resync.
  Key rotations arrive as identity events and, for `did:plc`, through the PLC
  export stream.
- **Backoff re-confirmation, a continuity backup.** A stream can drop an event
  without leaving a gap the monitor can see, so a monitor still values an
  affirmative direct read. It re-confirms each held DID's declaration against its
  PDS, comparing the record's CID (not the repo head, which moves on every
  commit), on an **exponential backoff**: the first interval is **one day**, it
  doubles after each confirmation that finds nothing changed, and it is capped
  at **30 days**. A firehose event for the
  DID, which already prompts a direct fetch, resets the backoff, and so does a
  confirmation that finds a change. Each
  confirmation is **jittered** within its interval, which spreads the requests
  out and keeps their time of day from tracking when the DID last changed. A
  quiet holder costs about one read a month. The other records a monitor
  keeps for a DID, such as a profile, follow the same events, backoff and
  resync.
- **Gaps.** Resuming from a cursor inside the stream's replay window keeps
  coverage continuous. When a monitor cannot resume (its cursor fell out of the
  window, or the stream reset), its watermark stops at the last instant it
  covered. It then **resyncs**: for each held DID it reads the declaration
  record and compares its CID with the one held, as the backoff does, and
  raises the DID's freshness as the check reaches it. The watermark advances
  again once the resync has reached every held DID
  ([the firehose coverage rule](#the-firehose-coverage-rule)). A resync costs one
  record read per holder, paid per gap. A restart of the PLC export stream without a
  usable cursor is a gap too: it ends the PLC coverage run, and the monitor
  re-confirms each held `did:plc` document and operation log
  ([below](#the-stored-did-document)).
- **Beyond one monitor.** Neither the stream nor one monitor's backoff is the
  last line: several independent monitors on independent streams, and the
  device's own-DID push, are
  ([the two comparisons](#the-two-comparisons-and-their-different-weights)).

### The stored DID document

A monitor keeps a DID document for each DID it watches and publishes it where
a relay reads it, so a relay can take a sender's signing key from the monitor
instead of asking the directory
([trust-model P5](trust-model.md#p5--sender-verification)).

- **Sources.** Every DID-document fetch the monitor makes also stores the
  document it resolved; that is the only source for `did:web`. For `did:plc`,
  the PLC export stream is rendered into the document the directory serves and
  stored when the directory sequences the operation. An operation the monitor
  cannot render, or a tombstone, is published as the absence of a document, so
  a relay asks the directory.
- **Write order.** Writes are ordered by when the directory held the state:
  a stream operation by its `createdAt`, a fetch by its start time less a
  clock-skew margin. A write older than what is stored MUST be dropped, so a
  fetch that read a document before an operation can never overwrite it.
- **Operation log.** For a `did:plc` DID the monitor also keeps the signed
  operation log, verified before it is stored, for a device to verify itself
  ([wire API](wire-api.md#did-documents)).

### The coverage watermarks

A monitor publishes two watermarks beside its stores, and a relay judges what
it reads by them, never by a per-DID refresh time:

- **Firehose coverage.** The instant through which every declaration commit
  and identity or account event the firehose sequenced has been applied, for
  every held DID not on a published lagging list
  ([the rule](#the-firehose-coverage-rule)). A snapshot's freshness is the later
  of this and the DID's last direct fetch.
- **PLC coverage run.** When the export stream's current unbroken run began,
  and the `createdAt` through which every operation since then has reached the
  stored documents. A run continues across a restart that resumes from the
  stored cursor, and ends on a start without a usable cursor or on an
  operation the monitor failed to take in.

A relay trusts a stored `did:plc` document while the document was confirmed
inside the current run and the run's covered-through time is no more than ten
minutes old. Any other stored document is trusted for ten minutes, the same as
a direct fetch. A missing or unreadable watermark is no coverage.

### The firehose coverage rule

The monitor publishes firehose coverage as one value, so a reader never pairs
one tick's watermark with another tick's list: `continuousSince` (ms),
`coveredThrough` (ms, or null) and `lagging` (DIDs, sorted). A missing or
malformed value is no coverage.

- **Owed and applied.** Taking in a stream event for a held DID **owes** a
  fetch of that DID; the stream cursor advances on taking the event in, not on
  applying it, so the cursor alone is not coverage. A fetch is **applied** when
  its record is stored, or at a terminal discharge: the record is gone, the
  fetched record would regress what is held, or the monitor holds the DID
  unverifiable (no key for the repo in the DID document, or bad bytes under the
  same key). For a DID held unverifiable the monitor's best knowledge stands. A
  fetch that fails for a reason that may pass (an unreachable PDS) stays owed.
  An event that arrives while a fetch is in flight owes a fetch of its own, and
  the fetch in flight does not discharge it.
- **Stamps.** Each owed stream event carries a stamp: its stream time. A DID
  owed several events carries the oldest. A fetch that has just been applied
  keeps its stamp for **60 seconds** (`KV_VISIBILITY_MS`), so the watermark
  never passes an event whose stored record may not yet be visible to every
  reader of the store. An owe that no stream event caused (a backfill, a join,
  a PLC event) carries no stamp and holds the watermark back by nothing.
- **Covered-through** is the earlier of the stream cursor's time and the oldest
  stamp among the held DIDs that are not lagging. With no stamp it is the
  cursor's time.
- **Lagging.** A held DID whose oldest stamp is more than ten minutes
  (`FIREHOSE_COVERAGE_MAX_LAG_MS`) older than the monitor's clock, judged by
  the event's age and not by how long the fetch has been owed, is lagging: it
  leaves the minimum above and is listed in `lagging`, so one unreachable PDS
  cannot hold back every other holder. A lagging DID leaves the list once its
  fetch is applied and its 60 seconds have passed. A stamp from before stamps existed counts as the oldest
  possible, so it lags at once. Past 1000 lagging DIDs (`FIREHOSE_LAGGING_CAP`)
  the monitor publishes `coveredThrough` as null: coverage that excuses that
  many holders is not coverage.
- **Held.** Only a held DID's stamp counts. A DID the monitor does not hold
  serves nothing, so it cannot make a served record stale.
- **Run.** `continuousSince` is when the current unbroken run began. Coverage
  is null while `coveredThrough` is before `continuousSince`, and until the
  stream has delivered a cursor, so a watermark never claims time from before
  the stream was whole.
- **Gaps.** A **gap** is either of two observations: at connect, a stored cursor
  older than the stream's replay window; or, after a resume from a cursor inside
  the window, a first frame whose time is past that cursor by more than a
  tolerance (events were skipped). On a gap the monitor starts a new run at the
  gap instant and owes **every served DID** (every DID it holds a declaration
  for, not one it holds as gone), stamped one millisecond before the gap
  instant. The ordinary rule
  then finishes the resync: `coveredThrough` is held before the gap instant, so
  coverage is null until each DID has been fetched or has become lagging, and
  there is no separate resync state. A gap longer than ten minutes puts every
  re-owed holder on `lagging` at once, and `coveredThrough` is null while there
  are more than 1000 of them. A monitor settling 32 DIDs on each two-minute
  alarm clears about 960 holders an hour, which an operator sizes the gap
  response by.
- **Key rotations.** Firehose coverage does not follow a `did:plc` key rotation;
  the PLC coverage run does. A summary's `w` is the earlier of the two
  ([wire API](wire-api.md#summary)).
- **`did:web`.** No stream covers a `did:web` document, so firehose coverage
  says nothing about the current key of a `did:web` DID.
- **Clocks.** A watermark is a stream event time. A reader compares it with its
  own clock, under the same assumption as the PLC run: clocks agree to well
  within the ten-minute bound.

### Reads and the 24-hour rule

A **relay** relies on a held snapshot for a pair put while the snapshot's
freshness is within 24 hours. Past that, the monitor has fallen behind, and
the relay checks the DID's PDS, comparing the record's CID only. If the PDS
cannot be read, the older snapshot stands. If the record changed or is gone,
the put is refused until the monitor catches up
([trust-model P5](trust-model.md#p5--sender-verification)). With continuous
coverage this never fires; it bounds a monitor whose stream has broken for a
day and whose resync has not yet reached that DID.

A **device read** does not wait: a lapsed declaration is served as held, and
the monitor is asked to move that DID forward in its resync. The read that
follows tells the PDS that someone is interested in the DID, though not who
or when.

### Which DID directory a device queries

- **`did:plc`**: a device may query the PLC directory directly by default; a
  user setting routes PLC queries through the PMR instead.
- **`did:web`**: a device does not query the host directly, since that reaches
  the identity's own host. The PMR proxies `did:web` documents, as a hint the
  device may confirm with the host.

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
  change digest, which covers the same need without a second mechanism.
- **A stronger rotation anchor.** `signingKey` alone says *that* the
  authority differs, not *when* it changed relative to either observation.
  For `did:plc`, the PLC log's operation CID would place a rotation in
  time rather than merely flag it — an extra fetch against the log, worth
  adding alongside the client-side verifier. `did:web` has no equivalent;
  a document digest is the best available there.
