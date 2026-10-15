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
check does not replace the client's (Q-PMR-24). This is the community view. A
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

### Reads and the 24-hour rule

A **relay** that relies on a held snapshot for a pair put checks it against the
DID's PDS once it is 24 hours unconfirmed, comparing the record's CID only. If
the PDS cannot be read, the older snapshot stands; if the record changed or is
gone, the put is refused until the monitor catches up
([trust-model P5](trust-model.md#p5--sender-verification)). A monitor in that
role therefore re-confirms held snapshots on a schedule, so the check is the
exception.

A **device read** does not wait: a lapsed declaration is served as held, and
the monitor is asked to re-check it afterwards. The re-check tells the PDS that
someone is interested in the DID, though not who or when.

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
  the `changedSince` seam it would have used was removed with the
  DO-read-offload refactor since it had no production caller.
- **A stronger rotation anchor.** `signingKey` alone says *that* the
  authority differs, not *when* it changed relative to either observation.
  For `did:plc`, the PLC log's operation CID would place a rotation in
  time rather than merely flag it — an extra fetch against the log, worth
  adding alongside the client-side verifier. `did:web` has no equivalent;
  a document digest is the best available there.
