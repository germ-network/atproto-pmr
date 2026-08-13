# Atproto PMR — storage consistency contract

_The persistence interface an Atproto PMR's logic runs against, and the
guarantees that interface must provide. Backend-neutral by construction.
Requirements language is defined in
[`README.md`](README.md#requirements-language). Read this alongside
[`wire-api.md`](wire-api.md) — that one is the surface you expose, this one
is the state behind it._

This is a generic storage contract, and an adopter may conform on the
backend of their choice. Its shape is influenced by a deployment on
Cloudflare's [Durable Objects](https://developers.cloudflare.com/durable-objects/)
and [KV](https://developers.cloudflare.com/kv/) primitives; alternatives
such as [celld](https://celld.dev) exist.

The contract exists because the guarantees a relay needs are **free on some
backends and absent on others**. A serialized, single-threaded per-tenant
execution model hands you serialized appends, atomic read-modify-write, and
scheduled alarms without asking. A relational backend gives none of them
implicitly, and a Postgres or SQLite adapter must supply each one
deliberately. An adapter that quietly does not is where correctness bugs
come from.

## Shape: a directory and a per-PMR store

Two levels, because the split is the same shape whichever backend you use:
an index plus a per-tenant unit, or a table plus rows scoped by tenant.

- **Directory** — finds and creates relays. Global, small, read on every
  inbound request.
- **Per-PMR store** — everything scoped to one served DID.

Every per-PMR operation is implicitly scoped to its relay; the scope is not
a parameter on each call.

The directory returns a **locator** — whatever an adapter needs to reach
that relay's store: an object identifier, a primary key, or the DID itself.
It is not called a *handle*: in atproto a handle is a user's human-readable
identifier that resolves to a DID, and this is neither user-facing nor an
identity.

Isolation between co-hosted relays is a property of the adapter, and part
of what the contract below has to state — an adopter on conventional
storage gets none of it from the execution model.

## Operations

A sketch, not an IDL. The names and the grouping are the design content;
exact signatures belong to an implementation.

### Directory

| operation | notes |
|---|---|
| `resolve(did) -> Locator?` | hot path; routes every pair put and every owner request |
| `resolveAddress(address) -> (Locator, GrantRecord)?` | grant puts name no DID, so the address must resolve globally before any relay is known. **Carries the uniform-cost requirement below** |
| `create(did, registration) -> Locator` | idempotent on DID |
| `delete(did)` | deregistration and dormancy eviction |
| `dueForWork(kind, before, limit) -> [Locator]` | drives declaration watch and sweeps where alarms do not exist — see [Scheduling](#scheduling) |

### Registration state

`load()` / `update(fields)` over: the served DID, the trusted anchor key,
the push grant this relay holds (if the deployment uses
[push delegation](wire-api.md#push-delegation-optional)), policy
configuration, a last-active timestamp, and record timestamps.

The anchor key MUST be stored as a **self-describing `COSE_Key` blob, never
a fixed-width column**, encoded per RFC 8949 §4.2.1, so that a new
algorithm arrives as a new identifier rather than a schema migration. The
key arrives from the declaration in a foreign encoding and MUST be
converted at ingest (see
[`wire-api.md` §Key material](wire-api.md#key-material)), so nothing
downstream of registration handles two formats.

The push grant, where present, is a **capability, not an identity**: an
identifier, a symmetric key, and an expiry. A relay MUST NOT store a push
token.

### Declaration watch

`readWatchState()` / `writeWatchState(...)` over: the last observed
declaration revision, the last check time, the currently trusted anchor
key, and the paused flag set when the declared key disappears. Scheduling
is separate.

### Mailboxes

Three shapes, distinguished by what routes to them:

- **Pair mailboxes** — keyed by counterpart DID, *within* this relay's
  store. Routing already resolved the recipient DID to this store, so the
  key is a local index: it needs no global uniqueness and no derivation on
  the wire.
- **Grant mailboxes** — keyed by the derived opaque address, which is
  itself the routing key and therefore MUST resolve globally, before any
  relay is known.
- **The recovery pool** — for senders with no provisioned mailbox. Shallow
  per sender, wide in sender count, and **newest-wins on overflow** rather
  than refusing.

| operation | notes |
|---|---|
| `append(mailboxKey, messageRef) -> Appended \| Refused(full)` | **refuses at capacity — never accept-and-evict**; the cap check and the write MUST be one atomic step, or two concurrent puts both see room |
| `appendToPool(senderKey, messageRef)` | **never returns `Refused`** under ordinary pressure; it evicts |
| `list(mailboxKey, limit) -> [messageRef]` | drain for delivery |
| `remove(mailboxKey, messageId)` | ack; **idempotent** |
| `openMailboxes(limit, cursor)` | reconnect drain, retention sweeps |
| `poolSenders() -> [senderKey]` | adjudication; **DIDs only, never bodies** |

**Do not implement the pool by reusing `append` with a different cap.** The
eviction direction is opposite, and conflating them is how a recovery
attempt gets refused or a first-contact message silently dropped — the two
failures each policy exists to prevent, swapped.

The pool is bounded two ways, and neither rations sender count directly: a
*threshold* on distinct senders triggers an adjudication round, and a
*byte cap* applies only when that round never comes. Bytes rather than
senders is deliberate — width is the property the pool exists to provide —
so under pressure `appendToPool` reduces per-sender depth before it turns
any sender away, and only at true exhaustion (cap reached, depth already
minimal) does it refuse senders not already present, keeping earlier
arrivals rather than evicting them. Both values are
**implementation-defined**; the reasoning is what transfers, not any
constant. See
[`wire-api.md` §Limits](wire-api.md#limits-are-implementation-defined).

Message **bodies** are a separate store — `putBody(id, bytes, expiresAt)`,
`getBody(id)`, `deleteBody(id)`. An adapter MAY back both with one table;
the interface keeps them separate so the queue stays small regardless of
body size.

A pair-mailbox entry also carries the relay's **verification hint** — the
DID and anchor key it validated the payload against. Store it *alongside*
the body, never inside it: the body is self-authenticating and the device
re-verifies it, so the hint is an index and a convenience, not evidence. An
adapter that loses or corrupts hints degrades performance; one that lets a
hint substitute for verification degrades security.

#### Two suppression records, not interchangeable

Both are per-sender suppression, and confusing them produces a wrong answer
to a sender:

| | blocked | discarded |
|---|---|---|
| applies to | a **provisioned** sender the recipient blocked | an **unprovisioned** sender the device declined |
| put answers | `202` / `429` per the synthetic state | `202`, as any unprovisioned put does |
| lifetime | until unblocked | **expires, deliberately** |
| bodies stored | none | none |

Neither is observable to the sender, and each matches the population it is
drawn from — which is what keeps them indistinguishable from the ordinary
behavior of that population.

For a **blocked** sender, storage MUST hold no message bytes and MUST write
no queue rows. The append path for a blocked sender advances whatever
synthetic state the implementation keeps and returns the same
`Appended | Refused(full)` shape a real mailbox would, so that the response
is indistinguishable. Three properties matter to an adapter:

- The synthetic state needs **no scheduled job and no sweep** — it can be
  a small per-sender record evaluated when a put arrives.
- It MUST NOT touch delivery — no queue entry, no socket frame, no push.
- It MUST NOT be observably cheaper. The response path runs the same
  sender verification and answers on the same timing profile as a real
  mailbox. This is the parity requirement from
  [`wire-api.md` §Blocked senders](wire-api.md#blocked-senders), and it is
  the one an adapter is most likely to break by accident, because "we can
  skip the write here" looks like an optimization.

Blocking is reversible, so the record survives unblocking as ordinary reset
state.

The concrete synthetic behavior is the implementer's, deliberately
unpublished, and free to change. This document specifies the storage
obligations it creates, not the behavior itself.

### Grants

`issue(grant)`, `close`, `reopen`, `invalidate`, `sweepExpired` — plus the
directory's `resolveAddress`, which carries the uniform-cost requirement
from the contract below.

### Attachments

`reserve`, `put`, `getRange(digest, offset)`, `delete`, `listForPMR`, plus
budget accounting. **Ranged reads are a hard requirement** — a client
resuming an interrupted transfer picks up at a segment boundary.

### Challenges

`mint(challenge, boundTo, expiresAt)` and `consume(challenge) -> Binding?`,
**global rather than per-relay**, because a challenge is presented before
the relay is known. The value is a *server challenge* — freshness and
bounded replay, not use-once. Consumption is best-effort; the contract
below says what carries the weight instead.

An implementation MAY avoid this store entirely by minting server-MAC'd
tokens that verify on redemption without a lookup.

### Observation cache

`put(kind, key, value, expiresAt)`, `get(kind, key)`,
`invalidate(kind, key)` for counterpart declarations, the mutuals edge, and
appview reads.

**Deliberately the weakest tier.** This data is public, re-fetchable, and
disposable, so an adapter MAY serve stale entries, lose the cache entirely,
or decline to persist it at all. Nothing about correctness may depend on
it.

Two requirements follow from the trust model, because this cache feeds the
observation channel:

- Entries for key-bearing records MUST retain the **CAR bytes and their
  proof**, not a parsed summary. The device authenticates the record, so
  the relay must be able to hand over exactly what it verified against.
- Each entry SHOULD carry its source repo `rev`, so the relay never serves
  a record older than one it has already passed on.

Storing bytes rather than a parsed form is also what lets an
implementation stay light: a relay that forwards what it fetched needs no
CAR parser, no MST walk, and none of the libraries those imply. Parsing
becomes defense in depth against a lying PDS, added deliberately.

### Scheduling

`scheduleWork(at, kind)` / `cancelWork(kind)`. A backend with per-tenant
alarms implements this directly; an adapter with no alarm equivalent
implements it as cron plus the directory's `dueForWork` query. Both must
exist in the interface, or an adopter on a relational backend has no way to
run declaration watch.

What does not need scheduling: pool adjudication is triggered by threshold
or by connect, the blocked-sender synthetic state is evaluated when a put
arrives, and expiry is an observability rule rather than a sweep.
Scheduling is for declaration watch and retention reclamation.

## The consistency contract

Seven requirements. Each is normative, and each is something a relational
adapter must supply deliberately.

### 1. Serialized append per mailbox

`append` MUST apply its capacity check and its write **atomically**, or a
concurrent pair of sends can both observe room and both write. A serialized
execution model gives this for free; elsewhere it is a transaction or a
lock.

*Note what not to copy from a serialized backend.* An implementation whose
per-tenant execution is single-threaded can afford to rewrite a whole
`sender → queue` map on every append — safe there, and a contention hot
spot anywhere else. A relational adapter SHOULD key rows per mailbox
instead.

### 2. Challenge freshness, not exactly-once

The value a client signs is a **server challenge**. Its job is to prove the
requester is interacting *now* and to bound replay to the challenge TTL,
not to guarantee use-once. Consumption is therefore best-effort: a store
with no atomic compare-and-delete shortens the replay window without
closing it, and an adapter is not required to do better.

The load-bearing requirement lands on the *operations*, not the challenge:
**every challenge-reachable operation MUST be replay-tolerant within the
TTL** — idempotent, content-addressed and deduplicated, or independently
sequenced. Right-size the TTL to that tolerance rather than assuming the
challenge enforces uniqueness.

One operation has no natural dedup and therefore needs its own
containment: [push-delegation submit](wire-api.md#push-delegation-optional),
because a delivered notification is a user-visible side effect.

### 3. Atomic counters

Attachment budgets, daily caps, and per-sender caps are read-modify-write.
Under contention they need **real atomicity, not last-writer-wins**. An
adapter that implements a counter as read-then-write without a transaction
or an atomic primitive has silently removed every quota in the system.

### 4. Expiry is semantic, not incidental

An implementation that leans on a store's native TTL gets expiry for free.
A relational adapter has no TTL, so expiry is defined here as an
**observability rule**:

> **A record past its `expiresAt` MUST NEVER be returned by any read**,
> regardless of how reclamation works.

Reclamation itself is the adapter's business — a native TTL here, a sweep
there. An adapter that implements expiry only as a background sweep MUST
still filter on read, because between sweeps the rows are still there and a
read that returns one has resurrected an expired message.

### 5. Uniform cost for address resolution

`resolveAddress` MUST do the **same work** for a live address, a closed
one, and one that never existed.

This is not a storage nicety. Closure exists so a blocked sender cannot
detect blocking, and an adapter that returns early on a missing row leaks
it through latency — the response bytes are identical and the property is
gone anyway. See
[`wire-api.md` §The closure exception](wire-api.md#the-closure-exception).

### 6. Idempotent removal

`remove` and the attachment acks MUST **succeed on already-removed
records**. The client's ack path retries, and an error on a second ack
turns a normal retry into a permanent failure.

### 7. The anti-replay nonce check is atomic with the append

The pair-put nonce ([wire-api.md §Anti-replay](wire-api.md#anti-replay))
MUST be checked and recorded in the **same atomic step** as the mailbox
append. A separate `hasSeen`-then-`append` pair of calls reopens exactly
the race requirement 1 closes, for replay instead of capacity: two
concurrent replays both observe "unseen" and both write.

Two further requirements travel with it:

- **The check MUST apply identically on the blocked path.** If a replay
  advances synthetic state where a real mailbox's replay would not, the
  difference in when the response flips to `429` is an oracle for
  blocked-versus-real — defeating
  [P4](trust-model.md#p4--blocking-indistinguishability) without the
  attacker touching the mailbox itself.
- **A refused outcome MUST NOT record the nonce.** Only an outcome that
  actually persists a message may. Otherwise a client's legitimate retry of
  the identical signed envelope — the natural behavior after `429` +
  `Retry-After` — is permanently misread as a replay of an attempt that
  never succeeded, and the message can never land.

## Out of scope

Not this interface's concern, and an adopter should not have to implement
any of it to satisfy the contract:

- **Transport** — sockets and HTTP.
- **Cryptography** — all signature verification and all key handling. The
  storage layer holds key *blobs*; it never interprets them.
- **Policy decisions.** The relay's core decides policy; storage only holds
  the configuration it decides from.
- **Push delivery**, which for a self-hosted relay runs through
  [delegation](wire-api.md#push-delegation-optional) anyway.

## Not yet specified

- **The blob interface for adopters.** An adopter likely has a filesystem
  or an S3-compatible bucket rather than the object store a reference
  implementation uses. Ranged reads are the hard requirement; whether the
  interface exposes a stream or a byte range is open.
- **Whether the observation cache belongs in this interface at all**, given
  an adapter may drop it entirely. The argument for keeping it is that
  adopters who *do* persist it should not each invent the shape.
- **The recovery pool's cross-sender cap.** Per-sender depth (shallow) and
  eviction within a sender (newest wins) are settled; whether the pool also
  needs a cap *across* senders beyond the byte bound, and what it evicts
  when it hits one, is open.
- **Migration and versioning of the stored shapes**, once there is a v2.
